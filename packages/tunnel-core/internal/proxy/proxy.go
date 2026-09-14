// SPDX-License-Identifier: Apache-2.0
// Package proxy exposes a loopback-only HTTP origin to the mobile WebView and
// keeps the tailnet device token outside the page.
package proxy

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
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
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
)

const (
	CookieName         = "cialai_k"
	DesktopHost        = "cialai-desktop"
	DefaultPort        = 47400
	LastReservedPort   = 47409
	defaultReadTimeout = 60 * time.Second
)

type Tunnel interface {
	Peer(string) (node.Peer, bool)
	Dial(context.Context, string, string) (net.Conn, error)
}

type Config struct {
	Tunnel         Tunnel
	DesktopID      string
	DesktopNodeKey string
	DesktopPort    int
	DeviceToken    string
	Random         io.Reader
	Now            func() time.Time
	ReadTimeout    time.Duration
	OnToken        func(string) error
}

type OpenResult struct {
	URL     string `json:"url"`
	Port    int    `json:"port"`
	Nonce   string `json:"nonce"`
	Warning string `json:"warning,omitempty"`
}

type Proxy struct {
	config       Config
	target       *url.URL
	transport    *http.Transport
	reverse      *httputil.ReverseProxy
	mu           sync.RWMutex
	token        string
	nonce        string
	nonceClaimed bool
	port         int
	listener     net.Listener
	server       *http.Server
}

func New(config Config) (*Proxy, error) {
	if config.Tunnel == nil || strings.TrimSpace(config.DesktopID) == "" || !validNodeKey(config.DesktopNodeKey) || config.DesktopPort < 1 || config.DesktopPort > 65535 || !validDeviceToken(config.DeviceToken) {
		return nil, errors.New("valid tunnel, desktop and device token are required")
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
	instance := &Proxy{config: config, token: config.DeviceToken, target: &url.URL{Scheme: "http", Host: DesktopHost}}
	instance.transport = &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          2,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       65 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		DialContext:           instance.dialContext,
	}
	instance.reverse = instance.newReverseProxy()
	return instance, nil
}

func validNodeKey(value string) bool {
	if !strings.HasPrefix(value, "nodekey:") || len(value) != len("nodekey:")+64 {
		return false
	}
	for _, character := range strings.TrimPrefix(value, "nodekey:") {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') && (character < 'A' || character > 'F') {
			return false
		}
	}
	return true
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

func (proxy *Proxy) newReverseProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Transport: proxy.transport,
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
			if next == "" {
				return nil
			}
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

func (proxy *Proxy) dialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	peer, ok := proxy.config.Tunnel.Peer(proxy.config.DesktopNodeKey)
	if !ok {
		return nil, errors.New("desktop peer is not visible")
	}
	host := peer.IP4
	if host == "" {
		host = peer.IP6
	}
	if host == "" {
		return nil, errors.New("desktop peer has no address")
	}
	connection, err := proxy.config.Tunnel.Dial(ctx, network, net.JoinHostPort(host, strconv.Itoa(proxy.config.DesktopPort)))
	if err != nil {
		return nil, err
	}
	return &activityConn{Conn: connection, timeout: proxy.config.ReadTimeout, now: proxy.config.Now}, nil
}

type activityConn struct {
	net.Conn
	timeout time.Duration
	now     func() time.Time
}

func (connection *activityConn) Read(buffer []byte) (int, error) {
	if err := connection.Conn.SetReadDeadline(connection.now().Add(connection.timeout)); err != nil {
		return 0, err
	}
	return connection.Conn.Read(buffer)
}

func (proxy *Proxy) problem(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

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
	if server != nil {
		return server.Shutdown(ctx)
	}
	if listener != nil {
		return listener.Close()
	}
	return nil
}
