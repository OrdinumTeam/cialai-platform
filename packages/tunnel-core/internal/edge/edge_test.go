// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

type fakeWhoIs struct {
	identity node.Identity
	err      error
}

func (source fakeWhoIs) WhoIs(context.Context, string) (node.Identity, error) {
	return source.identity, source.err
}

type fakeExpirer struct {
	ids chan uint64
}

func (admin *fakeExpirer) ExpirePreAuthKey(_ context.Context, id uint64) error {
	admin.ids <- id
	return nil
}

func edgeEntropy(size int) []byte {
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index%251 + 1)
	}
	return data
}

func edgeID(prefix string, size int, value byte) string {
	return prefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, size))
}

func writeStaticFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "mobile.html"), []byte("<main>Cialai mobile</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "app.js"), []byte("window.cialai=true"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".secret"), []byte("never"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func baseConfig(t *testing.T, bridgeURL string) Config {
	t.Helper()
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	desktop := pairing.DesktopIdentity{ID: edgeID("d_", 16, 1), Name: "MacBook de Foco", CreatedAt: now}
	registry, err := pairing.OpenRegistry(paths, desktop, func() time.Time { return now }, bytes.NewReader(edgeEntropy(4096)))
	if err != nil {
		t.Fatal(err)
	}
	return Config{
		StaticDir: writeStaticFixture(t), BridgeURL: bridgeURL, ProxySecret: "bridge-secret", Desktop: desktop,
		Sessions: pairing.NewSessions(func() time.Time { return now }, bytes.NewReader(edgeEntropy(4096)), false),
		Devices:  registry, WhoIs: fakeWhoIs{identity: node.Identity{NodeKey: "nodekey:" + strings.Repeat("b", 64), NodeID: "17", UserID: "42", IP: "100.64.0.9"}},
		Now: func() time.Time { return now },
	}
}

func TestStaticSiteAndHealthAreConfinedAndHardened(t *testing.T) {
	config := baseConfig(t, "http://127.0.0.1:3720")
	server, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path        string
		status      int
		cache       string
		contains    string
		contentType string
	}{
		{"/", 200, "no-store", "Cialai mobile", "text/html"},
		{"/mobile.html", 200, "no-store", "Cialai mobile", "text/html"},
		{"/projects/one", 200, "no-store", "Cialai mobile", "text/html"},
		{"/assets/app.js", 200, "public, max-age=31536000, immutable", "window.cialai", "text/javascript"},
		{"/assets/missing.js", 404, "", "", ""},
		{"/.secret", 404, "", "", ""},
		{"/%2e%2e/outside", 404, "", "", ""},
	} {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://edge"+test.path, nil)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.status || (test.contains != "" && !strings.Contains(response.Body.String(), test.contains)) {
				t.Fatalf("unexpected response: HTTP %d %q", response.Code, response.Body.String())
			}
			if test.cache != "" && response.Header().Get("Cache-Control") != test.cache {
				t.Fatalf("unexpected cache header: %q", response.Header().Get("Cache-Control"))
			}
			if test.contentType != "" && !strings.HasPrefix(response.Header().Get("Content-Type"), test.contentType) {
				t.Fatalf("unexpected content type: %q", response.Header().Get("Content-Type"))
			}
			if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Content-Security-Policy") == "" {
				t.Fatal("security headers missing")
			}
		})
	}

	request := httptest.NewRequest(http.MethodGet, "http://edge/api/health", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"service":"cialai"`) || strings.Contains(response.Body.String(), "bridge-secret") {
		t.Fatalf("bad health response: %d %s", response.Code, response.Body.String())
	}

	backslash := httptest.NewRequest(http.MethodGet, "http://edge/", nil)
	backslash.URL.Path = `/assets\app.js`
	response = httptest.NewRecorder()
	server.ServeHTTP(response, backslash)
	if response.Code != http.StatusNotFound {
		t.Fatal("backslash path was accepted")
	}

	if runtime.GOOS != "windows" {
		outside := filepath.Join(t.TempDir(), "outside.txt")
		_ = os.WriteFile(outside, []byte("outside"), 0o600)
		if err := os.Symlink(outside, filepath.Join(config.StaticDir, "assets", "escape.txt")); err != nil {
			t.Fatal(err)
		}
		request = httptest.NewRequest(http.MethodGet, "http://edge/assets/escape.txt", nil)
		response = httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "outside") {
			t.Fatal("static symlink escaped the root")
		}
	}
}

func TestPairUsesSessionWhoIsRegistryAndExpiresEnrollmentKey(t *testing.T) {
	config := baseConfig(t, "http://127.0.0.1:3720")
	expirer := &fakeExpirer{ids: make(chan uint64, 1)}
	config.KeyExpirer = expirer
	server, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	authKey := "hskey-auth-test"
	payload := pairing.Payload{
		ControlURL: "https://hs.example.com", UserID: "42", UserName: "foco", AuthKey: &authKey,
		Desktop: pairing.Desktop{ID: config.Desktop.ID, Name: config.Desktop.Name, NodeKey: "nodekey:" + strings.Repeat("a", 64), IP4: "100.64.0.3", Port: 4740},
	}
	active, err := config.Sessions.Begin(payload, 17, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := pairing.Decode(active.Payload, false)
	body := map[string]any{"v": 1, "pairId": active.PairID, "secret": decoded.Secret, "device": map[string]any{
		"name": "iPhone de Foco", "model": "iPhone16,1", "platform": "ios", "app": "1.0.0", "nodeKey": "nodekey:" + strings.Repeat("b", 64),
	}}
	raw, _ := json.Marshal(body)
	request := httptest.NewRequest(http.MethodPost, "http://edge/pair", bytes.NewReader(raw))
	request.RemoteAddr = "100.64.0.9:51234"
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("pair failed: HTTP %d %s", response.Code, response.Body.String())
	}
	var result struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
		Desktop  struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Port int    `json:"port"`
		} `json:"desktop"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.DeviceID == "" || result.Token == "" || result.Desktop.Port != 4740 {
		t.Fatalf("bad pair result: %#v %v", result, err)
	}
	if device, ok := config.Devices.Authenticate(result.Token); !ok || device.NodeKey != "nodekey:"+strings.Repeat("b", 64) {
		t.Fatalf("issued token not registered: %#v %v", device, ok)
	}
	select {
	case id := <-expirer.ids:
		if id != 17 {
			t.Fatalf("wrong enrollment key expired: %d", id)
		}
	case <-time.After(time.Second):
		t.Fatal("enrollment key was not expired asynchronously")
	}
	if _, err := config.Sessions.Consume(active.PairID, decoded.Secret); pairing.Code(err) != "pair_consumed" {
		t.Fatalf("pair session remained reusable: %v", err)
	}
}

func TestPairRateLimitAndIdentityMismatch(t *testing.T) {
	config := baseConfig(t, "http://127.0.0.1:3720")
	server, _ := New(config)
	for attempt := 1; attempt <= 6; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "http://edge/pair", strings.NewReader(`{"v":1,"pairId":"p_unknown","secret":"wrong","device":{"name":"Phone","model":"Model","platform":"ios","app":"1","nodeKey":"nodekey:`+strings.Repeat("b", 64)+`"}}`))
		request.RemoteAddr = "100.64.0.20:1234"
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if attempt <= 5 && response.Code == http.StatusTooManyRequests {
			t.Fatalf("rate limited request %d too early", attempt)
		}
		if attempt == 6 && response.Code != http.StatusTooManyRequests {
			t.Fatalf("sixth pairing request was not limited: HTTP %d", response.Code)
		}
	}

	config = baseConfig(t, "http://127.0.0.1:3720")
	config.WhoIs = fakeWhoIs{identity: node.Identity{NodeKey: "nodekey:" + strings.Repeat("c", 64), NodeID: "17", UserID: "42", IP: "100.64.0.9"}}
	server, _ = New(config)
	authKey := "hskey-auth-test"
	active, _ := config.Sessions.Begin(pairing.Payload{ControlURL: "https://hs.example.com", UserID: "42", UserName: "foco", AuthKey: &authKey, Desktop: pairing.Desktop{ID: config.Desktop.ID, Name: config.Desktop.Name, NodeKey: "nodekey:" + strings.Repeat("a", 64), IP4: "100.64.0.3", Port: 4740}}, 17, time.Minute)
	payload, _ := pairing.Decode(active.Payload, false)
	raw, _ := json.Marshal(map[string]any{"v": 1, "pairId": active.PairID, "secret": payload.Secret, "device": map[string]any{"name": "Phone", "model": "Model", "platform": "ios", "app": "1", "nodeKey": "nodekey:" + strings.Repeat("b", 64)}})
	request := httptest.NewRequest(http.MethodPost, "http://edge/pair", bytes.NewReader(raw))
	request.RemoteAddr = "100.64.0.9:1234"
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "pair_node_mismatch") {
		t.Fatalf("WhoIs mismatch accepted: HTTP %d %s", response.Code, response.Body.String())
	}
}

func TestAuthenticatedUpgradeStripsSpoofedHeadersAndInjectsBridgeIdentity(t *testing.T) {
	observed := make(chan http.Header, 1)
	bridge := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		observed <- request.Header.Clone()
		response.WriteHeader(http.StatusNoContent)
	}))
	defer bridge.Close()
	config := baseConfig(t, bridge.URL)
	device, token, err := config.Devices.Pair(pairing.DeviceInput{
		Name: "Phone", Model: "Model", Platform: "ios", App: "1", NodeKey: "nodekey:" + strings.Repeat("b", 64), NodeID: "17", UserID: "42", IP4: "100.64.0.9", RemoteAddr: "100.64.0.9:1234",
	})
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://edge/pty", nil)
	request.RemoteAddr = "100.64.0.9:1234"
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Origin", "http://127.0.0.1:47400")
	request.Header.Set("X-Cialai-Proxy-Secret", "spoofed")
	request.Header.Set("X-Cialai-Device-Id", "spoofed")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("proxy failed: HTTP %d %s", response.Code, response.Body.String())
	}
	headers := <-observed
	if headers.Get("X-Cialai-Proxy-Secret") != "bridge-secret" || headers.Get("X-Cialai-Device-Id") != device.ID || headers.Get("X-Cialai-Node-Key") != device.NodeKey {
		t.Fatalf("trusted headers missing: %#v", headers)
	}
	if headers.Get("Authorization") != "" || headers.Get("Origin") != "http://127.0.0.1:47400" {
		t.Fatalf("credentials leaked or Origin lost: %#v", headers)
	}

	request = httptest.NewRequest(http.MethodGet, "http://edge/pty", nil)
	request.RemoteAddr = "100.64.0.9:1234"
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated upgrade accepted: HTTP %d", response.Code)
	}
}

func TestSuccessfulUpgradeOffersAThirtyDayTokenRotation(t *testing.T) {
	clock := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	paths, _ := statedir.Prepare(filepath.Join(t.TempDir(), "state"))
	desktop := pairing.DesktopIdentity{ID: edgeID("d_", 16, 1), Name: "Desktop", CreatedAt: clock}
	registry, _ := pairing.OpenRegistry(paths, desktop, func() time.Time { return clock }, bytes.NewReader(edgeEntropy(1024)))
	device, oldToken, err := registry.Pair(pairing.DeviceInput{
		Name: "Phone", Model: "Model", Platform: "ios", App: "1", NodeKey: "nodekey:" + strings.Repeat("b", 64), NodeID: "17", UserID: "42", IP4: "100.64.0.9", RemoteAddr: "100.64.0.9:1234",
	})
	if err != nil {
		t.Fatal(err)
	}
	config := Config{
		StaticDir: writeStaticFixture(t), BridgeURL: "http://127.0.0.1:3720", ProxySecret: "secret", Desktop: desktop,
		Sessions: pairing.NewSessions(func() time.Time { return clock }, bytes.NewReader(edgeEntropy(512)), false), Devices: registry,
		WhoIs: fakeWhoIs{}, Now: func() time.Time { return clock },
	}
	server, _ := New(config)
	clock = clock.Add(31 * 24 * time.Hour)
	request := httptest.NewRequest(http.MethodGet, "http://edge/pty", nil)
	request = request.WithContext(context.WithValue(request.Context(), bridgeIdentityKey{}, bridgeIdentity{Device: device}))
	response := &http.Response{StatusCode: http.StatusSwitchingProtocols, Header: make(http.Header), Request: request}
	if err := server.proxy.ModifyResponse(response); err != nil {
		t.Fatal(err)
	}
	newToken := response.Header.Get("X-Cialai-Token-Next")
	if newToken == "" || newToken == oldToken {
		t.Fatal("upgrade did not offer a rotated token")
	}
	if _, ok := registry.Authenticate(oldToken); !ok {
		t.Fatal("old token lost its 24-hour grace window")
	}
	if _, ok := registry.Authenticate(newToken); !ok {
		t.Fatal("new token was not persisted")
	}
}

func TestSocketLimitsArePerDeviceAndGlobal(t *testing.T) {
	server, _ := New(baseConfig(t, "http://127.0.0.1:3720"))
	first, ok := server.acquire("dev_one", nil)
	if !ok {
		t.Fatal("first socket refused")
	}
	second, ok := server.acquire("dev_one", nil)
	if !ok {
		t.Fatal("second socket refused")
	}
	if _, ok := server.acquire("dev_one", nil); ok {
		t.Fatal("third socket for one device accepted")
	}
	releases := []func(){first, second}
	for index := 0; index < 6; index++ {
		release, accepted := server.acquire("dev_"+string(rune('a'+index)), nil)
		if !accepted {
			t.Fatalf("socket %d refused before global limit", index+3)
		}
		releases = append(releases, release)
	}
	if _, ok := server.acquire("dev_extra", nil); ok {
		t.Fatal("ninth global socket accepted")
	}
	for _, release := range releases {
		release()
	}
}

func TestConfigRejectsUnsafeBridgeAndMissingDependencies(t *testing.T) {
	config := baseConfig(t, "http://example.com:3720")
	if _, err := New(config); err == nil {
		t.Fatal("accepted a non-loopback bridge")
	}
	config = baseConfig(t, "http://127.0.0.1:3720")
	config.ProxySecret = ""
	if _, err := New(config); err == nil {
		t.Fatal("accepted a missing bridge secret")
	}
	config = baseConfig(t, "http://127.0.0.1:3720")
	config.WhoIs = fakeWhoIs{err: errors.New("offline")}
	server, _ := New(config)
	request := httptest.NewRequest(http.MethodGet, "http://edge/pty", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Authorization", "Bearer invalid")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatal("invalid token reached WhoIs")
	}
}
