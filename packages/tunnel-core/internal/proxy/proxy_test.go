// SPDX-License-Identifier: Apache-2.0
package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
)

type fakeTunnel struct {
	mu       sync.Mutex
	peer     node.Peer
	targets  []string
	endpoint string
}

func (tunnel *fakeTunnel) Peer(string) (node.Peer, bool) {
	tunnel.mu.Lock()
	defer tunnel.mu.Unlock()
	return tunnel.peer, tunnel.peer.NodeKey != ""
}

func (tunnel *fakeTunnel) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	tunnel.mu.Lock()
	tunnel.targets = append(tunnel.targets, address)
	endpoint := tunnel.endpoint
	tunnel.mu.Unlock()
	var dialer net.Dialer
	return dialer.DialContext(ctx, network, endpoint)
}

func (tunnel *fakeTunnel) setPeer(peer node.Peer) {
	tunnel.mu.Lock()
	tunnel.peer = peer
	tunnel.mu.Unlock()
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

func newTestProxy(t *testing.T, tunnel *fakeTunnel, token string, onToken func(string) error) *Proxy {
	t.Helper()
	instance, err := New(Config{
		Tunnel: tunnel, DesktopID: "desktop-one", DesktopNodeKey: "nodekey:" + strings.Repeat("a", 64),
		DesktopPort: 4740, DeviceToken: token, Random: bytes.NewReader(proxyEntropy(512)), OnToken: onToken,
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
	proxy := newTestProxy(t, &fakeTunnel{}, deviceToken(1), nil)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/?k="+proxy.nonce, nil)
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "/" {
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
	endpoint := backend.Listener.Addr().String()
	tunnel := &fakeTunnel{peer: node.Peer{NodeKey: "nodekey:" + strings.Repeat("a", 64), IP4: "100.64.0.3"}, endpoint: endpoint}
	updated := make(chan string, 1)
	proxy := newTestProxy(t, tunnel, oldToken, func(token string) error { updated <- token; return nil })
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
}

func TestPeerAddressIsResolvedAgainForEveryDial(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) }))
	defer backend.Close()
	tunnel := &fakeTunnel{peer: node.Peer{NodeKey: "nodekey:" + strings.Repeat("a", 64), IP4: "100.64.0.3"}, endpoint: backend.Listener.Addr().String()}
	proxy := newTestProxy(t, tunnel, deviceToken(4), nil)
	for _, ip := range []string{"100.64.0.3", "100.64.0.99"} {
		tunnel.setPeer(node.Peer{NodeKey: "nodekey:" + strings.Repeat("a", 64), IP4: ip})
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47400/api/health", nil)
		request.AddCookie(&http.Cookie{Name: CookieName, Value: proxy.nonce})
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("proxy request failed: HTTP %d", response.Code)
		}
		proxy.transport.CloseIdleConnections()
	}
	tunnel.mu.Lock()
	targets := append([]string(nil), tunnel.targets...)
	tunnel.mu.Unlock()
	if len(targets) != 2 || targets[0] != "100.64.0.3:4740" || targets[1] != "100.64.0.99:4740" {
		t.Fatalf("peer address was cached: %v", targets)
	}
}

func TestWebSocketOriginMustMatchLoopbackProxyOrBeAbsent(t *testing.T) {
	proxy := newTestProxy(t, &fakeTunnel{}, deviceToken(5), nil)
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

func TestTunnelReadDeadlineRenewsOnEveryRead(t *testing.T) {
	clock := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	underlying := &deadlineConn{}
	connection := &activityConn{Conn: underlying, timeout: time.Minute, now: func() time.Time { return clock }}
	buffer := make([]byte, 1)
	_, _ = connection.Read(buffer)
	clock = clock.Add(20 * time.Second)
	_, _ = connection.Read(buffer)
	if len(underlying.deadlines) != 2 || !underlying.deadlines[0].Equal(time.Date(2026, 9, 12, 20, 1, 0, 0, time.UTC)) || !underlying.deadlines[1].Equal(time.Date(2026, 9, 12, 20, 1, 20, 0, time.UTC)) {
		t.Fatalf("read deadlines were not renewed: %v", underlying.deadlines)
	}
}

func TestOpenBindsOnlyLoopbackAndFallsBackAcrossReservedPorts(t *testing.T) {
	proxy, err := New(Config{
		Tunnel: &fakeTunnel{}, DesktopID: "desktop", DesktopNodeKey: "nodekey:" + strings.Repeat("a", 64),
		DesktopPort: 4740, DeviceToken: deviceToken(6), Random: bytes.NewReader(proxyEntropy(512)),
	})
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

func TestConfigRejectsInvalidTokensAndDesktopIdentity(t *testing.T) {
	for _, config := range []Config{
		{Tunnel: &fakeTunnel{}, DesktopID: "desktop", DesktopNodeKey: "bad", DesktopPort: 4740, DeviceToken: deviceToken(1)},
		{Tunnel: &fakeTunnel{}, DesktopID: "desktop", DesktopNodeKey: "nodekey:" + strings.Repeat("a", 64), DesktopPort: 0, DeviceToken: deviceToken(1)},
		{Tunnel: &fakeTunnel{}, DesktopID: "desktop", DesktopNodeKey: "nodekey:" + strings.Repeat("a", 64), DesktopPort: 4740, DeviceToken: "invalid"},
	} {
		if _, err := New(config); err == nil {
			t.Fatalf("accepted invalid config: %#v", config)
		}
	}
}
