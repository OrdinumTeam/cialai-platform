// SPDX-License-Identifier: Apache-2.0
// Package proxy exposes a loopback-only HTTP origin to the mobile WebView and
// keeps the device token outside the page. Every upstream connection is one
// stream to the desktop edge opened through the path manager, so the page does
// not know whether the direct QUIC path or the Tor fallback carries it.
//
// When the path manager switches paths, PathChanged closes the upstreams that
// the previous path carried, WebSockets included. The page reconnects and asks
// the bridge for a replay by offset; the proxy never writes a byte it already
// forwarded a second time, because it neither buffers nor retries a stream.
//
// Failures the proxy can prove are reported to the path manager: a WebSocket
// whose bridge stayed silent for the read timeout, which spans three lost
// bridge pings, and the 4401 close the bridge sends after a revocation, which
// revokes the manager.
package proxy

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
)

const (
	CookieName       = "cialai_k"
	DesktopHost      = "cialai-desktop"
	DefaultPort      = 47400
	LastReservedPort = 47409
	// RevokedCloseCode is the WebSocket close status of the bridge after the
	// desktop revoked this phone.
	RevokedCloseCode   = 4401
	defaultReadTimeout = 60 * time.Second
	// maxPathDials bounds the dials of one upstream while the active path keeps
	// changing under it.
	maxPathDials = 3
)

// Dialer is the path manager seen by the proxy; *pathmgr.Manager implements
// it. DialContext opens one stream over the active path, Active names that
// path and ReportFailure receives the failures the proxy proves.
type Dialer interface {
	pathmgr.Dialer
	Active() pathmgr.Path
	ReportFailure(err error)
}

var _ Dialer = (*pathmgr.Manager)(nil)

type Config struct {
	Dialer      Dialer
	DesktopID   string
	DeviceToken string
	Random      io.Reader
	Now         func() time.Time
	ReadTimeout time.Duration
	OnToken     func(string) error
	// OnRevoked runs once when the bridge closes a socket with
	// RevokedCloseCode, before the path manager is revoked.
	OnRevoked func()
}

type OpenResult struct {
	URL     string `json:"url"`
	Port    int    `json:"port"`
	Nonce   string `json:"nonce"`
	Warning string `json:"warning,omitempty"`
}

type Proxy struct {
	config           Config
	target           *url.URL
	transport        *http.Transport
	upgradeTransport *http.Transport
	reverse          *httputil.ReverseProxy
	upgrade          *httputil.ReverseProxy
	mu               sync.RWMutex
	token            string
	nonce            string
	nonceClaimed     bool
	port             int
	listener         net.Listener
	server           *http.Server

	connMu    sync.Mutex
	upstreams map[*upstreamConn]struct{}
	revoked   atomic.Bool
}

func New(config Config) (*Proxy, error) {
	if config.Dialer == nil || strings.TrimSpace(config.DesktopID) == "" || !validDeviceToken(config.DeviceToken) {
		return nil, errors.New("valid dialer, desktop and device token are required")
	}
	if config.Random == nil {
		config.Random = rand.Reader
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.ReadTimeout == 0 {
		config.ReadTimeout = defaultReadTimeout
	}
	if config.ReadTimeout < time.Second {
		return nil, errors.New("proxy read timeout is too short")
	}
	instance := &Proxy{
		config: config, token: config.DeviceToken, target: &url.URL{Scheme: "http", Host: DesktopHost},
		upstreams: make(map[*upstreamConn]struct{}),
	}
	instance.transport = &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          2,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       65 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		DialContext:           instance.dialContext,
	}
	// Upgrades never reuse a pooled connection, so the upstream of every
	// WebSocket is the one its request dialed and can be watched.
	instance.upgradeTransport = &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     false,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 15 * time.Second,
		DialContext:           instance.dialContext,
	}
	instance.reverse = instance.newReverseProxy(instance.transport)
	instance.upgrade = instance.newReverseProxy(instance.upgradeTransport)
	return instance, nil
}

func validDeviceToken(token string) bool {
	parts := strings.Split(token, ".")
	return len(parts) == 3 && parts[0] == "cdt1" && validRawID(parts[1], "dev_", 16) && validRawID(parts[2], "", 32)
}

func validRawID(value, prefix string, size int) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	encoded := strings.TrimPrefix(value, prefix)
	if encoded == "" || strings.Contains(encoded, "=") {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(decoded) == size && base64.RawURLEncoding.EncodeToString(decoded) == encoded
}

func (proxy *Proxy) begin(port int) error {
	if port < 1 || port > 65535 {
		return errors.New("valid loopback port is required")
	}
	nonceBytes := make([]byte, 32)
	if _, err := io.ReadFull(proxy.config.Random, nonceBytes); err != nil {
		return fmt.Errorf("create proxy nonce: %w", err)
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if proxy.port != 0 {
		return errors.New("proxy is already open")
	}
	proxy.port = port
	proxy.nonce = base64.RawURLEncoding.EncodeToString(nonceBytes)
	proxy.nonceClaimed = false
	return nil
}

func (proxy *Proxy) Open(preferredPort int) (OpenResult, error) {
	listener, fallback, err := listenLoopback(preferredPort)
	if err != nil {
		return OpenResult{}, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := proxy.begin(port); err != nil {
		_ = listener.Close()
		return OpenResult{}, err
	}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 65 * time.Second}
	proxy.mu.Lock()
	proxy.listener = listener
	proxy.server = server
	nonce := proxy.nonce
	proxy.mu.Unlock()
	go func() { _ = server.Serve(listener) }()
	result := OpenResult{URL: "http://127.0.0.1:" + strconv.Itoa(port) + "/?k=" + url.QueryEscape(nonce), Port: port, Nonce: nonce}
	if fallback {
		result.Warning = "As portas reservadas estavam ocupadas; foi usada uma porta local temporária."
	}
	return result, nil
}

func listenLoopback(preferredPort int) (net.Listener, bool, error) {
	candidates := make([]int, 0, LastReservedPort-DefaultPort+2)
	if preferredPort > 0 {
		candidates = append(candidates, preferredPort)
	}
	for port := DefaultPort; port <= LastReservedPort; port++ {
		if port != preferredPort {
			candidates = append(candidates, port)
		}
	}
	for _, port := range candidates {
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			return listener, false, nil
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, false, fmt.Errorf("open loopback proxy: %w", err)
	}
	return listener, true, nil
}

func (proxy *Proxy) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Referrer-Policy", "no-referrer")
	proxy.mu.RLock()
	nonce := proxy.nonce
	port := proxy.port
	proxy.mu.RUnlock()
	if port == 0 || nonce == "" {
		proxy.problem(response, http.StatusServiceUnavailable, "proxy_closed", "O proxy local não está aberto.")
		return
	}
	if proxy.validCookie(request, nonce) {
		query := request.URL.Query()
		query.Del("k")
		request.URL.RawQuery = query.Encode()
		if isWebSocket(request) {
			expected := "http://127.0.0.1:" + strconv.Itoa(port)
			origin := request.Header.Get("Origin")
			if origin != "" && origin != expected {
				proxy.problem(response, http.StatusForbidden, "origin_invalid", "A origem da conexão local não foi aceita.")
				return
			}
			slot := &dialSlot{}
			proxy.upgrade.ServeHTTP(response, request.WithContext(context.WithValue(request.Context(), dialSlotKey{}, slot)))
			return
		}
		proxy.reverse.ServeHTTP(response, request)
		return
	}
	if request.Method == http.MethodGet && constantEqual(request.URL.Query().Get("k"), nonce) && proxy.claimNonce() {
		http.SetCookie(response, &http.Cookie{Name: CookieName, Value: nonce, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		response.Header().Set("Location", "/")
		response.WriteHeader(http.StatusFound)
		return
	}
	proxy.problem(response, http.StatusForbidden, "proxy_unauthorized", "Esta abertura local não é válida.")
}

func (proxy *Proxy) validCookie(request *http.Request, nonce string) bool {
	cookie, err := request.Cookie(CookieName)
	return err == nil && constantEqual(cookie.Value, nonce)
}

func constantEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (proxy *Proxy) claimNonce() bool {
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if proxy.nonceClaimed {
		return false
	}
	proxy.nonceClaimed = true
	return true
}

func isWebSocket(request *http.Request) bool {
	if !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, part := range strings.Split(request.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(part), "upgrade") {
			return true
		}
	}
	return false
}

func (proxy *Proxy) newReverseProxy(transport http.RoundTripper) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(proxy.target)
			request.Out.Host = DesktopHost
			for name := range request.Out.Header {
				if strings.HasPrefix(strings.ToLower(name), "x-cialai-") {
					request.Out.Header.Del(name)
				}
			}
			request.Out.Header.Del("Cookie")
			request.Out.Header.Set("Authorization", "Bearer "+proxy.currentToken())
		},
		ModifyResponse: func(response *http.Response) error {
			next := response.Header.Get("X-Cialai-Token-Next")
			response.Header.Del("X-Cialai-Token-Next")
			response.Header.Del("Set-Cookie")
			if next != "" {
				if !validDeviceToken(next) {
					return errors.New("edge returned an invalid rotated device token")
				}
				if proxy.config.OnToken != nil {
					if err := proxy.config.OnToken(next); err != nil {
						return fmt.Errorf("store rotated device token: %w", err)
					}
				}
				proxy.mu.Lock()
				proxy.token = next
				proxy.mu.Unlock()
			}
			if response.StatusCode == http.StatusSwitchingProtocols {
				return proxy.watchUpgrade(response)
			}
			return nil
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			proxy.problem(response, http.StatusBadGateway, "desktop_unreachable", "O computador não está acessível neste momento.")
		},
	}
}

func (proxy *Proxy) currentToken() string {
	proxy.mu.RLock()
	defer proxy.mu.RUnlock()
	return proxy.token
}

// dialSlot receives the upstream dialed for one upgrade request, so the
// response can watch the connection it arrived on.
type dialSlot struct {
	mu   sync.Mutex
	conn *upstreamConn
}

type dialSlotKey struct{}

func (slot *dialSlot) set(conn *upstreamConn) {
	slot.mu.Lock()
	slot.conn = conn
	slot.mu.Unlock()
}

func (slot *dialSlot) get() *upstreamConn {
	slot.mu.Lock()
	defer slot.mu.Unlock()
	return slot.conn
}

// dialContext opens one stream through the path manager. A stream whose dial
// saw the active path change may belong to either path; it is closed before
// any byte is written and dialed again.
func (proxy *Proxy) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	for attempt := 1; ; attempt++ {
		before := proxy.config.Dialer.Active()
		conn, err := proxy.config.Dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		upstream := &upstreamConn{Conn: conn, proxy: proxy}
		if proxy.track(upstream, before, attempt == maxPathDials) {
			if slot, ok := ctx.Value(dialSlotKey{}).(*dialSlot); ok {
				slot.set(upstream)
			}
			return upstream, nil
		}
		_ = conn.Close()
	}
}

// track registers conn as carried by the active path. Unless force is set, it
// refuses conn when the active path is not the one seen before the dial.
func (proxy *Proxy) track(conn *upstreamConn, before pathmgr.Path, force bool) bool {
	proxy.connMu.Lock()
	defer proxy.connMu.Unlock()
	after := proxy.config.Dialer.Active()
	if !force && (after != before || after.Transport == "") {
		return false
	}
	conn.path = after
	proxy.upstreams[conn] = struct{}{}
	return true
}

func (proxy *Proxy) untrack(conn *upstreamConn) {
	proxy.connMu.Lock()
	delete(proxy.upstreams, conn)
	proxy.connMu.Unlock()
}

// PathChanged closes every upstream that the active path does not carry. The
// path manager calls it, through its OnPath event, after each switch, so the
// streams of the previous path end and the page reconnects over the new one.
// It returns how many upstreams were closed.
func (proxy *Proxy) PathChanged(pathmgr.PathEvent) int {
	proxy.connMu.Lock()
	active := proxy.config.Dialer.Active()
	var stale []*upstreamConn
	for conn := range proxy.upstreams {
		if conn.path.Transport == "" || conn.path != active {
			stale = append(stale, conn)
		}
	}
	proxy.connMu.Unlock()
	for _, conn := range stale {
		_ = conn.Close()
	}
	return len(stale)
}

// Upstreams returns how many upstream streams are open.
func (proxy *Proxy) Upstreams() int {
	proxy.connMu.Lock()
	defer proxy.connMu.Unlock()
	return len(proxy.upstreams)
}

// watchUpgrade wraps the body of a 101 response, which is the upstream stream
// of the WebSocket, to follow the frames the bridge sends.
func (proxy *Proxy) watchUpgrade(response *http.Response) error {
	body, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		return errors.New("upgrade response body is not writable")
	}
	var conn *upstreamConn
	if slot, found := response.Request.Context().Value(dialSlotKey{}).(*dialSlot); found {
		conn = slot.get()
	}
	response.Body = &upgradedBody{ReadWriteCloser: body, proxy: proxy, conn: conn}
	return nil
}

// upgradedBody is the upstream half of a proxied WebSocket.
type upgradedBody struct {
	io.ReadWriteCloser
	proxy  *Proxy
	conn   *upstreamConn
	frames closeWatcher
}

func (body *upgradedBody) Read(buffer []byte) (int, error) {
	n, err := body.ReadWriteCloser.Read(buffer)
	if n > 0 {
		if status, closed := body.frames.feed(buffer[:n]); closed && status == RevokedCloseCode {
			body.proxy.reportRevoked()
		}
	}
	if err != nil {
		body.proxy.upgradeFailed(body.conn, err)
	}
	return n, err
}

// reportRevoked revokes the path manager once. It runs apart from the copy, so
// the close frame reaches the page before the manager closes the path.
func (proxy *Proxy) reportRevoked() {
	if !proxy.revoked.CompareAndSwap(false, true) {
		return
	}
	go func() {
		if proxy.config.OnRevoked != nil {
			proxy.config.OnRevoked()
		}
		proxy.config.Dialer.ReportFailure(fmt.Errorf("desktop bridge closed the socket with %d: %w", RevokedCloseCode, pathmgr.ErrRevoked))
	}()
}

// upgradeFailed reports a WebSocket whose bridge stayed silent for the read
// timeout. The bridge pings every 20 s, so the 60 s timeout means three lost
// pings. Upstreams the proxy closed itself and upstreams of a path that is no
// longer active are not reported, so a stale stream never fails a new path.
func (proxy *Proxy) upgradeFailed(conn *upstreamConn, err error) {
	var timeout net.Error
	if conn == nil || conn.closed.Load() || !errors.As(err, &timeout) || !timeout.Timeout() {
		return
	}
	proxy.connMu.Lock()
	current := conn.path.Transport != "" && conn.path == proxy.config.Dialer.Active()
	proxy.connMu.Unlock()
	if current {
		proxy.config.Dialer.ReportFailure(fmt.Errorf("desktop bridge silent for %s: %w", proxy.config.ReadTimeout, err))
	}
}

// upstreamConn is one stream to the desktop edge. Every read renews the read
// deadline.
type upstreamConn struct {
	net.Conn
	proxy     *Proxy
	path      pathmgr.Path
	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

func (conn *upstreamConn) Read(buffer []byte) (int, error) {
	if err := conn.Conn.SetReadDeadline(conn.proxy.config.Now().Add(conn.proxy.config.ReadTimeout)); err != nil {
		return 0, err
	}
	return conn.Conn.Read(buffer)
}

func (conn *upstreamConn) Close() error {
	conn.closeOnce.Do(func() {
		conn.closed.Store(true)
		conn.proxy.untrack(conn)
		conn.closeErr = conn.Conn.Close()
	})
	return conn.closeErr
}

// closeWatcher follows a stream of WebSocket frames sent by the server and
// reports the status of the first close frame. Server frames are not masked,
// but a mask is honored; data frames are skipped without being copied.
type closeWatcher struct {
	header    [14]byte
	have      int
	need      int
	opcode    byte
	masked    bool
	remaining uint64
	offset    uint64
	status    [2]byte
	done      bool
}

const opcodeClose = 0x8

func (watcher *closeWatcher) feed(data []byte) (uint16, bool) {
	for len(data) > 0 && !watcher.done {
		if watcher.have < 2 || watcher.have < watcher.need {
			watcher.header[watcher.have] = data[0]
			watcher.have++
			data = data[1:]
			if watcher.have == 2 {
				watcher.opcode = watcher.header[0] & 0x0f
				watcher.masked = watcher.header[1]&0x80 != 0
				watcher.need = 2
				switch watcher.header[1] & 0x7f {
				case 126:
					watcher.need += 2
				case 127:
					watcher.need += 8
				}
				if watcher.masked {
					watcher.need += 4
				}
			}
			if watcher.have >= 2 && watcher.have == watcher.need && watcher.startPayload() {
				return 0, false
			}
			continue
		}
		take := uint64(len(data))
		if take > watcher.remaining {
			take = watcher.remaining
		}
		if watcher.opcode == opcodeClose {
			for index := uint64(0); index < take && watcher.offset+index < 2; index++ {
				value := data[index]
				if watcher.masked {
					value ^= watcher.header[watcher.need-4+int((watcher.offset+index)%4)]
				}
				watcher.status[watcher.offset+index] = value
			}
			if watcher.offset < 2 && watcher.offset+take >= 2 {
				watcher.done = true
				return binary.BigEndian.Uint16(watcher.status[:]), true
			}
		}
		watcher.offset += take
		watcher.remaining -= take
		data = data[take:]
		if watcher.remaining == 0 && watcher.endFrame() {
			return 0, false
		}
	}
	return 0, false
}

// startPayload reads the payload length of a complete header. It reports true
// when the stream ended with a close frame that carries no status.
func (watcher *closeWatcher) startPayload() bool {
	switch length := watcher.header[1] & 0x7f; length {
	case 126:
		watcher.remaining = uint64(binary.BigEndian.Uint16(watcher.header[2:4]))
	case 127:
		watcher.remaining = binary.BigEndian.Uint64(watcher.header[2:10])
	default:
		watcher.remaining = uint64(length)
	}
	watcher.offset = 0
	if watcher.remaining == 0 {
		return watcher.endFrame()
	}
	return false
}

// endFrame prepares the next header; a finished close frame ends the watch.
func (watcher *closeWatcher) endFrame() bool {
	if watcher.opcode == opcodeClose {
		watcher.done = true
		return true
	}
	watcher.have, watcher.need = 0, 0
	return false
}

func (proxy *Proxy) problem(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// Close stops the loopback origin and closes every upstream, WebSockets
// included.
func (proxy *Proxy) Close(ctx context.Context) error {
	proxy.mu.Lock()
	server := proxy.server
	listener := proxy.listener
	proxy.server = nil
	proxy.listener = nil
	proxy.port = 0
	proxy.nonce = ""
	proxy.mu.Unlock()
	proxy.transport.CloseIdleConnections()
	proxy.upgradeTransport.CloseIdleConnections()
	proxy.connMu.Lock()
	open := make([]*upstreamConn, 0, len(proxy.upstreams))
	for conn := range proxy.upstreams {
		open = append(open, conn)
	}
	proxy.connMu.Unlock()
	for _, conn := range open {
		_ = conn.Close()
	}
	if server != nil {
		return server.Shutdown(ctx)
	}
	if listener != nil {
		return listener.Close()
	}
	return nil
}
