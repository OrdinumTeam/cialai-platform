// SPDX-License-Identifier: Apache-2.0
package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const testTimeout = 10 * time.Second

// fakeDialer stands in for the path manager: every path reaches the same
// loopback backend, and switching paths changes only what Active reports, so
// the proxy alone must close the upstreams of the previous path.
type fakeDialer struct {
	mu       sync.Mutex
	endpoint string
	path     pathmgr.Path
	dials    []pathmgr.Path
	wrap     func(net.Conn) net.Conn
	// duringDial runs after a stream is opened and before DialContext returns.
	duringDial func()
	failures   chan error
}

func newFakeDialer(endpoint string) *fakeDialer {
	dialer := &fakeDialer{endpoint: endpoint, failures: make(chan error, 16)}
	dialer.switchTo(pathmgr.KindLAN)
	return dialer
}

func (dialer *fakeDialer) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	dialer.mu.Lock()
	path, endpoint, wrap, during := dialer.path, dialer.endpoint, dialer.wrap, dialer.duringDial
	dialer.dials = append(dialer.dials, path)
	dialer.mu.Unlock()
	if path.Transport == "" {
		return nil, &pathmgr.Error{Code: pathmgr.CodeNoPath}
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return nil, err
	}
	if wrap != nil {
		conn = wrap(conn)
	}
	if during != nil {
		during()
	}
	return conn, nil
}

func (dialer *fakeDialer) Active() pathmgr.Path {
	dialer.mu.Lock()
	defer dialer.mu.Unlock()
	return dialer.path
}

func (dialer *fakeDialer) ReportFailure(err error) { dialer.failures <- err }

// switchTo makes a new path of kind active and returns its event.
func (dialer *fakeDialer) switchTo(kind pathmgr.Kind) pathmgr.PathEvent {
	dialer.mu.Lock()
	defer dialer.mu.Unlock()
	name := transport.NameDirect
	if kind == pathmgr.KindTor {
		name = transport.NameTor
	}
	since := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	if dialer.path.Transport != "" {
		since = dialer.path.Since.Add(time.Second)
	}
	dialer.path = pathmgr.Path{DesktopID: "desktop-one", Transport: name, Kind: kind, Since: since}
	return pathmgr.PathEvent{DesktopID: "desktop-one", Transport: name, Path: kind, Reason: pathmgr.ReasonPathFailed}
}

func (dialer *fakeDialer) dialed() []pathmgr.Path {
	dialer.mu.Lock()
	defer dialer.mu.Unlock()
	return append([]pathmgr.Path(nil), dialer.dials...)
}

func proxyEntropy(size int) []byte {
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index%251 + 1)
	}
	return data
}

func deviceToken(value byte) string {
	deviceID := "dev_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 16))
	secret := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value + 1}, 32))
	return "cdt1." + deviceID + "." + secret
}

func newTestProxy(t *testing.T, dialer Dialer, token string, onToken func(string) error) *Proxy {
	t.Helper()
	instance, err := New(Config{
		Dialer: dialer, DesktopID: "desktop-one", DeviceToken: token,
		Random: bytes.NewReader(proxyEntropy(512)), OnToken: onToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := instance.begin(47400); err != nil {
		t.Fatal(err)
	}
	return instance
}

func TestNonceBecomesStrictHTTPOnlyCookieAndIsSingleClaim(t *testing.T) {
	proxy := newTestProxy(t, newFakeDialer("127.0.0.1:9"), deviceToken(1), nil)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/?k="+proxy.nonce, nil)
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "/?bridge=ws%3A%2F%2F127.0.0.1%3A47400%2Fpty" {
		t.Fatalf("nonce bootstrap failed: HTTP %d headers %#v", response.Code, response.Header())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName || cookies[0].Value != proxy.nonce || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/" {
		t.Fatalf("unsafe bootstrap cookie: %#v", cookies)
	}
	request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/?k="+proxy.nonce, nil)
	response = httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("nonce was claimable twice: HTTP %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/", nil)
	response = httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("request without cookie was accepted: HTTP %d", response.Code)
	}
}

func TestAuthenticatedRequestInjectsBearerAndNeverLeaksSecretsToPage(t *testing.T) {
	oldToken := deviceToken(2)
	newToken := deviceToken(3)
	observed := make(chan *http.Request, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		clone := request.Clone(request.Context())
		clone.Header = request.Header.Clone()
		observed <- clone
		response.Header().Set("X-Cialai-Token-Next", newToken)
		response.Header().Add("Set-Cookie", "cialai_k=attacker; Path=/")
		response.Header().Set("X-Upstream", "ok")
		_, _ = response.Write([]byte(`{"status":"ok","service":"cialai"}`))
	}))
	defer backend.Close()
	updated := make(chan string, 1)
	proxy := newTestProxy(t, newFakeDialer(backend.Listener.Addr().String()), oldToken, func(token string) error { updated <- token; return nil })
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/api/health", nil)
	request.AddCookie(&http.Cookie{Name: CookieName, Value: proxy.nonce})
	request.Header.Set("Authorization", "Bearer browser-spoof")
	request.Header.Set("X-Cialai-Device-Id", "browser-spoof")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("X-Upstream") != "ok" || response.Header().Get("X-Cialai-Token-Next") != "" || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("unexpected proxy response: HTTP %d headers %#v", response.Code, response.Header())
	}
	upstream := <-observed
	if upstream.Host != DesktopHost || upstream.Header.Get("Authorization") != "Bearer "+oldToken {
		t.Fatalf("native authorization missing: host %q headers %#v", upstream.Host, upstream.Header)
	}
	if upstream.Header.Get("Cookie") != "" || upstream.Header.Get("X-Cialai-Device-Id") != "" {
		t.Fatalf("local-only headers leaked upstream: %#v", upstream.Header)
	}
	select {
	case token := <-updated:
		if token != newToken {
			t.Fatalf("wrong rotated token: %q", token)
		}
	case <-time.After(time.Second):
		t.Fatal("rotated token was not delivered to native storage")
	}
	if proxy.currentToken() != newToken {
		t.Fatal("proxy did not adopt the rotated token")
	}
	proxy.transport.CloseIdleConnections()
	if proxy.Upstreams() != 0 {
		t.Fatalf("%d upstreams still tracked after closing idle connections", proxy.Upstreams())
	}
}

func TestEveryUpstreamIsDialedThroughTheActivePath(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) }))
	defer backend.Close()
	dialer := newFakeDialer(backend.Listener.Addr().String())
	proxy := newTestProxy(t, dialer, deviceToken(4), nil)
	for _, kind := range []pathmgr.Kind{pathmgr.KindLAN, pathmgr.KindTor} {
		if kind != pathmgr.KindLAN {
			proxy.PathChanged(dialer.switchTo(kind))
		}
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/api/health", nil)
		request.AddCookie(&http.Cookie{Name: CookieName, Value: proxy.nonce})
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("proxy request over %s failed: HTTP %d", kind, response.Code)
		}
	}
	dials := dialer.dialed()
	if len(dials) != 2 || dials[0].Kind != pathmgr.KindLAN || dials[1].Kind != pathmgr.KindTor {
		t.Fatalf("pooled upstream survived the path change: %+v", dials)
	}
	dialer.mu.Lock()
	dialer.path = pathmgr.Path{}
	dialer.mu.Unlock()
	proxy.PathChanged(pathmgr.PathEvent{DesktopID: "desktop-one", Path: pathmgr.KindNone, Reason: pathmgr.CodeNoPath})
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/api/health", nil)
	request.AddCookie(&http.Cookie{Name: CookieName, Value: proxy.nonce})
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "desktop_unreachable") {
		t.Fatalf("request without a path returned HTTP %d %s", response.Code, response.Body)
	}
}

func TestDialSeeingThePathChangeIsDiscardedAndDialedAgain(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) }))
	defer backend.Close()
	dialer := newFakeDialer(backend.Listener.Addr().String())
	var switched atomic.Bool
	dialer.duringDial = func() {
		if switched.CompareAndSwap(false, true) {
			// The manager adopts the fallback while the first stream opens.
			dialer.mu.Lock()
			dialer.path = pathmgr.Path{DesktopID: "desktop-one", Transport: transport.NameTor, Kind: pathmgr.KindTor, Since: dialer.path.Since.Add(time.Second)}
			dialer.mu.Unlock()
		}
	}
	proxy := newTestProxy(t, dialer, deviceToken(4), nil)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/api/health", nil)
	request.AddCookie(&http.Cookie{Name: CookieName, Value: proxy.nonce})
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("request failed: HTTP %d", response.Code)
	}
	dials := dialer.dialed()
	if len(dials) != 2 || dials[1].Kind != pathmgr.KindTor {
		t.Fatalf("stream of an uncertain path was used: %+v", dials)
	}
	if count := proxy.PathChanged(pathmgr.PathEvent{Path: pathmgr.KindTor}); count != 0 {
		t.Fatalf("the redialed upstream was recorded on the wrong path, %d closed", count)
	}
}

func TestWebSocketOriginMustMatchLoopbackProxyOrBeAbsent(t *testing.T) {
	proxy := newTestProxy(t, newFakeDialer("127.0.0.1:9"), deviceToken(5), nil)
	for _, test := range []struct {
		origin string
		status int
	}{
		{"https://evil.example", http.StatusForbidden},
		{"http://127.0.0.1:47401", http.StatusForbidden},
	} {
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/pty", nil)
		request.AddCookie(&http.Cookie{Name: CookieName, Value: proxy.nonce})
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Origin", test.origin)
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("origin %q returned HTTP %d", test.origin, response.Code)
		}
	}
}

type deadlineConn struct {
	deadlines []time.Time
}

func (connection *deadlineConn) Read(buffer []byte) (int, error)  { return 0, io.EOF }
func (connection *deadlineConn) Write(buffer []byte) (int, error) { return len(buffer), nil }
func (connection *deadlineConn) Close() error                     { return nil }
func (connection *deadlineConn) LocalAddr() net.Addr              { return testAddr("local") }
func (connection *deadlineConn) RemoteAddr() net.Addr             { return testAddr("remote") }
func (connection *deadlineConn) SetDeadline(time.Time) error      { return nil }
func (connection *deadlineConn) SetWriteDeadline(time.Time) error { return nil }
func (connection *deadlineConn) SetReadDeadline(value time.Time) error {
	connection.deadlines = append(connection.deadlines, value)
	return nil
}

type testAddr string

func (address testAddr) Network() string { return "tcp" }
func (address testAddr) String() string  { return string(address) }

func TestUpstreamReadDeadlineRenewsOnEveryRead(t *testing.T) {
	clock := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	proxy, err := New(Config{Dialer: newFakeDialer("127.0.0.1:9"), DesktopID: "desktop", DeviceToken: deviceToken(6), Now: func() time.Time { return clock }, ReadTimeout: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	underlying := &deadlineConn{}
	connection := &upstreamConn{Conn: underlying, proxy: proxy}
	buffer := make([]byte, 1)
	_, _ = connection.Read(buffer)
	clock = clock.Add(20 * time.Second)
	_, _ = connection.Read(buffer)
	if len(underlying.deadlines) != 2 || !underlying.deadlines[0].Equal(time.Date(2026, 9, 12, 20, 1, 0, 0, time.UTC)) || !underlying.deadlines[1].Equal(time.Date(2026, 9, 12, 20, 1, 20, 0, time.UTC)) {
		t.Fatalf("read deadlines were not renewed: %v", underlying.deadlines)
	}
}

func TestOpenBindsOnlyLoopbackAndFallsBackAcrossReservedPorts(t *testing.T) {
	proxy, err := New(Config{Dialer: newFakeDialer("127.0.0.1:9"), DesktopID: "desktop", DeviceToken: deviceToken(6), Random: bytes.NewReader(proxyEntropy(512))})
	if err != nil {
		t.Fatal(err)
	}
	result, err := proxy.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close(context.Background())
	host, port, err := net.SplitHostPort(proxy.listener.Addr().String())
	if err != nil || host != "127.0.0.1" || port == "" || !strings.HasPrefix(result.URL, "http://127.0.0.1:") || result.Nonce == "" {
		t.Fatalf("unsafe open result: %#v addr %q err %v", result, proxy.listener.Addr(), err)
	}
}

func TestConfigRejectsInvalidTokensAndDesktop(t *testing.T) {
	dialer := newFakeDialer("127.0.0.1:9")
	for _, config := range []Config{
		{DesktopID: "desktop", DeviceToken: deviceToken(1)},
		{Dialer: dialer, DesktopID: " ", DeviceToken: deviceToken(1)},
		{Dialer: dialer, DesktopID: "desktop", DeviceToken: "invalid"},
		{Dialer: dialer, DesktopID: "desktop", DeviceToken: deviceToken(1), ReadTimeout: time.Millisecond},
	} {
		if _, err := New(config); err == nil {
			t.Fatalf("accepted invalid config: %#v", config)
		}
	}
}

// page is the mobile page: it bootstraps the proxy cookie and opens
// WebSockets to the loopback origin.
type page struct {
	opening OpenResult
	cookie  string
}

func openPage(t *testing.T, proxy *Proxy) *page {
	t.Helper()
	opening, err := proxy.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close(context.Background()) })
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(opening.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	for _, cookie := range response.Cookies() {
		if cookie.Name == CookieName {
			return &page{opening: opening, cookie: CookieName + "=" + cookie.Value}
		}
	}
	t.Fatalf("bootstrap returned HTTP %d without the cookie", response.StatusCode)
	return nil
}

func (page *page) dial(ctx context.Context) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/pty", page.opening.Port), &websocket.DialOptions{HTTPHeader: http.Header{
		"Cookie": {page.cookie},
		"Origin": {fmt.Sprintf("http://127.0.0.1:%d", page.opening.Port)},
	}})
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	t.Cleanup(cancel)
	return ctx
}

// bridge is a loopback WebSocket server standing in for the desktop edge and
// bridge; serve decides what each socket does with the messages it reads.
type bridge struct {
	server *httptest.Server
	mu     sync.Mutex
	// messages holds, per accepted socket, every complete message read.
	messages [][]string
	headers  []http.Header
}

func startBridge(t *testing.T, beforeAccept func(http.ResponseWriter), serve func(ctx context.Context, socket int, conn *websocket.Conn, message []byte) error) *bridge {
	t.Helper()
	instance := &bridge{}
	instance.server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if beforeAccept != nil {
			beforeAccept(response)
		}
		conn, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		instance.mu.Lock()
		socket := len(instance.messages)
		instance.messages = append(instance.messages, nil)
		instance.headers = append(instance.headers, request.Header.Clone())
		instance.mu.Unlock()
		ctx := request.Context()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			instance.mu.Lock()
			instance.messages[socket] = append(instance.messages[socket], string(data))
			instance.mu.Unlock()
			if serve != nil {
				if err := serve(ctx, socket, conn, data); err != nil {
					return
				}
			}
		}
	}))
	t.Cleanup(instance.server.Close)
	return instance
}

func (instance *bridge) address() string { return instance.server.Listener.Addr().String() }

func (instance *bridge) received() [][]string {
	instance.mu.Lock()
	defer instance.mu.Unlock()
	copied := make([][]string, len(instance.messages))
	for index, list := range instance.messages {
		copied[index] = append([]string(nil), list...)
	}
	return copied
}

func echo(ctx context.Context, _ int, conn *websocket.Conn, message []byte) error {
	return conn.Write(ctx, websocket.MessageText, message)
}

// TestPathChangeClosesOpenWebSocketWithoutResendingBytes is the CON-028
// criterion: a path change closes the open socket, the page reconnects over
// the new path and the bridge never reads a message twice.
func TestPathChangeClosesOpenWebSocketWithoutResendingBytes(t *testing.T) {
	ctx := testContext(t)
	backend := startBridge(t, nil, echo)
	dialer := newFakeDialer(backend.address())
	proxy, err := New(Config{Dialer: dialer, DesktopID: "desktop-one", DeviceToken: deviceToken(7)})
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, proxy)
	socket, _, err := page.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.CloseNow()
	for index := range 3 {
		message := fmt.Sprintf(`{"type":"pty_write","id":"w%d","data":"ls\n"}`, index)
		if err := socket.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
			t.Fatal(err)
		}
		if _, echoed, err := socket.Read(ctx); err != nil || string(echoed) != message {
			t.Fatalf("echo %d = %q, %v", index, echoed, err)
		}
	}
	if proxy.Upstreams() != 1 {
		t.Fatalf("upstreams = %d, want the socket only", proxy.Upstreams())
	}

	if closed := proxy.PathChanged(dialer.switchTo(pathmgr.KindTor)); closed != 1 {
		t.Fatalf("path change closed %d upstreams, want 1", closed)
	}
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	_, _, err = socket.Read(readCtx)
	cancel()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the socket stayed open after the path change: %v", err)
	}
	if proxy.Upstreams() != 0 {
		t.Fatalf("upstreams = %d after the path change", proxy.Upstreams())
	}

	again, _, err := page.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer again.CloseNow()
	replay := `{"type":"attach","offset":3}`
	if err := again.Write(ctx, websocket.MessageText, []byte(replay)); err != nil {
		t.Fatal(err)
	}
	if _, echoed, err := again.Read(ctx); err != nil || string(echoed) != replay {
		t.Fatalf("echo after reconnect = %q, %v", echoed, err)
	}
	dials := dialer.dialed()
	if len(dials) != 2 || dials[0].Kind != pathmgr.KindLAN || dials[1].Kind != pathmgr.KindTor {
		t.Fatalf("dials = %+v, want lan then tor", dials)
	}
	received := backend.received()
	if len(received) != 2 || len(received[0]) != 3 || len(received[1]) != 1 || received[1][0] != replay {
		t.Fatalf("bridge read %q, want three messages then only the replay request", received)
	}
	select {
	case failure := <-dialer.failures:
		t.Fatalf("a path change was reported as a failure: %v", failure)
	default:
	}
}

// slowConn writes in small chunks, so a path change can land in the middle
// of one WebSocket frame.
type slowConn struct {
	net.Conn
	chunk int
	pause time.Duration
}

func (conn *slowConn) Write(data []byte) (int, error) {
	written := 0
	for written < len(data) {
		end := min(written+conn.chunk, len(data))
		n, err := conn.Conn.Write(data[written:end])
		written += n
		if err != nil {
			return written, err
		}
		time.Sleep(conn.pause)
	}
	return written, nil
}

// TestPathChangeDuringPTYWriteDeliversTheCommandAtMostOnce is the Go part of
// CON-063: a path change while a pty_write frame is on its way leaves the
// command executed once or not at all, never twice. The page follows the
// protocol and asks for a replay by offset instead of writing again.
func TestPathChangeDuringPTYWriteDeliversTheCommandAtMostOnce(t *testing.T) {
	ctx := testContext(t)
	var executedMu sync.Mutex
	executed := map[string]int{}
	backend := startBridge(t, nil, func(ctx context.Context, _ int, conn *websocket.Conn, message []byte) error {
		var frame struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(message, &frame); err != nil {
			return err
		}
		if frame.Type == "pty_write" {
			executedMu.Lock()
			executed[frame.ID]++
			executedMu.Unlock()
		}
		return conn.Write(ctx, websocket.MessageText, []byte(`{"type":"ack","id":"`+frame.ID+`"}`))
	})
	dialer := newFakeDialer(backend.address())
	dialer.wrap = func(conn net.Conn) net.Conn { return &slowConn{Conn: conn, chunk: 256, pause: time.Millisecond} }
	proxy, err := New(Config{Dialer: dialer, DesktopID: "desktop-one", DeviceToken: deviceToken(8)})
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, proxy)
	// Random text keeps the frame large even if compression is negotiated.
	noise := make([]byte, 9<<10)
	for index := range noise {
		noise[index] = byte(rand.IntN(256))
	}
	payload := base64.RawStdEncoding.EncodeToString(noise)
	const rounds = 16
	outcomes := map[int]int{}
	for round := range rounds {
		socket, _, err := page.dial(ctx)
		if err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		id := fmt.Sprintf("w%d", round)
		frame := []byte(`{"type":"pty_write","id":"` + id + `","data":"` + payload + `"}`)
		written := make(chan error, 1)
		go func() { written <- socket.Write(ctx, websocket.MessageText, frame) }()
		time.Sleep(time.Duration(rand.IntN(60)) * time.Millisecond)
		kinds := []pathmgr.Kind{pathmgr.KindTor, pathmgr.KindDirect}
		proxy.PathChanged(dialer.switchTo(kinds[round%2]))
		<-written
		socket.CloseNow()

		// The page reconnects and asks for the replay; it never repeats the
		// write, acknowledged or not.
		again, _, err := page.dial(ctx)
		if err != nil {
			t.Fatalf("round %d reconnect: %v", round, err)
		}
		probe := fmt.Sprintf(`{"type":"attach","id":"a%d"}`, round)
		if err := again.Write(ctx, websocket.MessageText, []byte(probe)); err != nil {
			t.Fatal(err)
		}
		if _, answer, err := again.Read(ctx); err != nil || !strings.Contains(string(answer), fmt.Sprintf(`"a%d"`, round)) {
			t.Fatalf("round %d replay answer %q, %v", round, answer, err)
		}
		again.CloseNow()
		executedMu.Lock()
		count := executed[id]
		executedMu.Unlock()
		if count > 1 {
			t.Fatalf("round %d: pty_write executed %d times", round, count)
		}
		outcomes[count]++
	}
	// A frame cut by the path change is never completed by the proxy later.
	time.Sleep(100 * time.Millisecond)
	executedMu.Lock()
	defer executedMu.Unlock()
	for id, count := range executed {
		if count > 1 {
			t.Fatalf("pty_write %s executed %d times", id, count)
		}
	}
	t.Logf("pty_write outcomes over %d path changes: executed once %d, not executed %d", rounds, outcomes[1], outcomes[0])
}

func TestBridgeRevocationCloseRevokesThePathManager(t *testing.T) {
	ctx := testContext(t)
	var sockets atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if sockets.Add(1) == 1 {
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return
		}
		// A long data frame first, so the close is found past other frames.
		_ = conn.Write(request.Context(), websocket.MessageBinary, bytes.Repeat([]byte{0x88}, 70000))
		_ = conn.Close(RevokedCloseCode, "Dispositivo revogado.")
	}))
	defer backend.Close()
	dialer := newFakeDialer(backend.Listener.Addr().String())
	var notified atomic.Int32
	proxy, err := New(Config{Dialer: dialer, DesktopID: "desktop-one", DeviceToken: deviceToken(9), OnRevoked: func() { notified.Add(1) }})
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, proxy)
	// A normal close is not a failure.
	normal, _, err := page.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := normal.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("normal close = %v", err)
	}
	normal.CloseNow()
	select {
	case failure := <-dialer.failures:
		t.Fatalf("a normal close was reported: %v", failure)
	case <-time.After(100 * time.Millisecond):
	}

	revoked, _, err := page.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoked.CloseNow()
	revoked.SetReadLimit(1 << 20)
	if _, data, err := revoked.Read(ctx); err != nil || len(data) != 70000 {
		t.Fatalf("data frame before the close = %d bytes, %v", len(data), err)
	}
	_, _, err = revoked.Read(ctx)
	if websocket.CloseStatus(err) != RevokedCloseCode {
		t.Fatalf("page saw %v, want the 4401 close", err)
	}
	select {
	case failure := <-dialer.failures:
		if !errors.Is(failure, pathmgr.ErrRevoked) || pathmgr.Code(failure) != pathmgr.CodeRevoked {
			t.Fatalf("reported %v, want a revocation", failure)
		}
		if notified.Load() != 1 {
			t.Fatalf("OnRevoked ran %d times before the report", notified.Load())
		}
	case <-time.After(testTimeout):
		t.Fatal("the 4401 close was not reported to the path manager")
	}
}

func TestSilentBridgeIsReportedOnlyForTheActivePath(t *testing.T) {
	ctx := testContext(t)
	backend := startBridge(t, nil, func(context.Context, int, *websocket.Conn, []byte) error { return nil })
	plain := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) }))
	defer plain.Close()

	// An idle pooled HTTP connection reaching its read deadline is not a
	// failure: only a WebSocket has bridge pings to lose.
	httpDialer := newFakeDialer(plain.Listener.Addr().String())
	idle, err := New(Config{Dialer: httpDialer, DesktopID: "desktop-one", DeviceToken: deviceToken(10), ReadTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	idlePage := openPage(t, idle)
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/health", idlePage.opening.Port), nil)
	request.Header.Set("Cookie", idlePage.cookie)
	response, err := http.DefaultClient.Do(request)
	if err != nil || response.StatusCode != http.StatusNoContent {
		t.Fatalf("health through the proxy = %v, %v", response, err)
	}
	_ = response.Body.Close()

	dialer := newFakeDialer(backend.address())
	proxy, err := New(Config{Dialer: dialer, DesktopID: "desktop-one", DeviceToken: deviceToken(10), ReadTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, proxy)
	started := time.Now()
	socket, _, err := page.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.CloseNow()
	select {
	case failure := <-dialer.failures:
		var timeout net.Error
		if !errors.As(failure, &timeout) || !timeout.Timeout() || time.Since(started) < time.Second {
			t.Fatalf("reported %v after %s, want the read timeout", failure, time.Since(started))
		}
	case <-time.After(testTimeout):
		t.Fatal("the silent bridge was not reported")
	}
	select {
	case failure := <-httpDialer.failures:
		t.Fatalf("an idle HTTP connection was reported: %v", failure)
	case <-time.After(500 * time.Millisecond):
	}

	// A socket of a path that is no longer active is not reported, even when
	// the change was not delivered yet.
	stale, _, err := page.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer stale.CloseNow()
	dialer.switchTo(pathmgr.KindTor)
	select {
	case failure := <-dialer.failures:
		t.Fatalf("a stale path was reported: %v", failure)
	case <-time.After(1500 * time.Millisecond):
	}
}

// TestRotatedTokenOnUpgradeReachesNativeAndNextUpgrade covers the proxy part of
// CON-064: the edge rotates only inside a successful upgrade.
func TestRotatedTokenOnUpgradeReachesNativeAndNextUpgrade(t *testing.T) {
	ctx := testContext(t)
	oldToken, newToken := deviceToken(11), deviceToken(12)
	var rotations atomic.Int32
	backend := startBridge(t, func(response http.ResponseWriter) {
		if rotations.Add(1) == 1 {
			response.Header().Set("X-Cialai-Token-Next", newToken)
		}
	}, echo)
	dialer := newFakeDialer(backend.address())
	stored := make(chan string, 2)
	proxy, err := New(Config{Dialer: dialer, DesktopID: "desktop-one", DeviceToken: oldToken, OnToken: func(token string) error { stored <- token; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	page := openPage(t, proxy)
	for round := range 2 {
		socket, response, err := page.dial(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if response.Header.Get("X-Cialai-Token-Next") != "" {
			t.Fatalf("round %d: rotated token reached the page", round)
		}
		if err := socket.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
			t.Fatal(err)
		}
		if _, _, err := socket.Read(ctx); err != nil {
			t.Fatal(err)
		}
		socket.CloseNow()
	}
	select {
	case token := <-stored:
		if token != newToken {
			t.Fatalf("native received %q", token)
		}
	default:
		t.Fatal("rotated token was not delivered to native")
	}
	backend.mu.Lock()
	headers := append([]http.Header(nil), backend.headers...)
	backend.mu.Unlock()
	if len(headers) != 2 || headers[0].Get("Authorization") != "Bearer "+oldToken || headers[1].Get("Authorization") != "Bearer "+newToken {
		t.Fatalf("upgrade authorizations = %v", headers)
	}
}

func closeFrame(status uint16, masked bool) []byte {
	payload := binary.BigEndian.AppendUint16(nil, status)
	payload = append(payload, "bye"...)
	header := []byte{0x80 | opcodeClose, byte(len(payload))}
	if !masked {
		return append(header, payload...)
	}
	mask := []byte{0x11, 0x22, 0x33, 0x44}
	header[1] |= 0x80
	header = append(header, mask...)
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	return append(header, payload...)
}

func dataFrame(size int) []byte {
	frame := []byte{0x82}
	switch {
	case size < 126:
		frame = append(frame, byte(size))
	case size <= 0xffff:
		frame = append(frame, 126)
		frame = binary.BigEndian.AppendUint16(frame, uint16(size))
	default:
		frame = append(frame, 127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(size))
	}
	return append(frame, bytes.Repeat([]byte{0x88}, size)...)
}

func TestCloseWatcherFindsTheStatusAcrossSplitReads(t *testing.T) {
	for _, masked := range []bool{false, true} {
		stream := append(append(append(append([]byte{}, dataFrame(0)...), dataFrame(125)...), dataFrame(300)...), dataFrame(70000)...)
		stream = append(stream, []byte{0x89, 0x00}...) // ping without payload
		stream = append(stream, closeFrame(4401, masked)...)
		for _, chunk := range []int{1, 2, 3, 7, 1000, len(stream)} {
			var watcher closeWatcher
			var status uint16
			found := false
			for offset := 0; offset < len(stream); offset += chunk {
				if code, closed := watcher.feed(stream[offset:min(offset+chunk, len(stream))]); closed {
					status, found = code, true
				}
			}
			if !found || status != 4401 {
				t.Fatalf("masked %v chunk %d: status %d found %v", masked, chunk, status, found)
			}
		}
	}
	var watcher closeWatcher
	if _, closed := watcher.feed([]byte{0x88, 0x00}); closed {
		t.Fatal("a close without status reported a status")
	}
	if _, closed := watcher.feed(closeFrame(4401, false)); closed {
		t.Fatal("frames after the first close were followed")
	}
}
