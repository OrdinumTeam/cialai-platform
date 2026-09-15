// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha3"
	"encoding/base32"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const testTimeout = 10 * time.Second

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *testClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *testClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

type eventLog struct {
	mu     sync.Mutex
	events []recordedEvent
}

type recordedEvent struct {
	name string
	data any
}

func (log *eventLog) sink(name string, data any) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.events = append(log.events, recordedEvent{name: name, data: data})
}

// wait returns the data of the first event named name that matches.
func (log *eventLog) wait(t *testing.T, name string, match func(any) bool) any {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		log.mu.Lock()
		for _, event := range log.events {
			if event.name == name && (match == nil || match(event.data)) {
				log.mu.Unlock()
				return event.data
			}
		}
		log.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("event %s not emitted", name)
	return nil
}

type edgeHarness struct {
	desktop  *identity.Identity
	server   *Server
	config   Config
	clock    *testClock
	events   *eventLog
	listener *fakeListener
	onion    string
	served   chan error
}

func testOnion(public ed25519.PublicKey) string {
	material := append(append([]byte(".onion checksum"), public...), 0x03)
	checksum := sha3.Sum256(material)
	raw := append(append(append([]byte{}, public...), checksum[:2]...), 0x03)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)) + ".onion:443"
}

func mustIdentity(t *testing.T, role identity.Role) *identity.Identity {
	t.Helper()
	local, err := identity.Generate(role, nil)
	if err != nil {
		t.Fatal(err)
	}
	return local
}

func phoneKey(t *testing.T) string {
	t.Helper()
	return mustIdentity(t, identity.RolePhone).PublicKeyString()
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

// prepareEdge builds a server over a real v2 registry and pairing sessions
// without starting it.
func prepareEdge(t *testing.T, bridgeURL string) *edgeHarness {
	t.Helper()
	desktopIdentity := mustIdentity(t, identity.RoleDesktop)
	desktop := pairing.Desktop{ID: desktopIdentity.ID(), Name: "MacBook de Foco", PublicKey: desktopIdentity.PublicKeyString()}
	clock := &testClock{now: time.Date(2026, 9, 14, 20, 0, 0, 0, time.UTC)}
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	registry, err := pairing.OpenRegistry(paths, pairing.DesktopIdentity{ID: desktop.ID, Name: desktop.Name, CreatedAt: clock.Now()}, clock.Now, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &edgeHarness{desktop: desktopIdentity, clock: clock, events: &eventLog{}, onion: testOnion(desktopIdentity.PublicKey())}
	h.config = Config{
		StaticDir: writeStaticFixture(t), BridgeURL: bridgeURL, ProxySecret: "bridge-secret", Desktop: desktop,
		Reach: func() ReachCard {
			return ReachCard{Onion: h.onion, Candidates: []pairing.Candidate{{Type: pairing.CandidateLAN, Address: "192.168.15.23:4740"}}}
		},
		Sessions: pairing.NewSessions(clock.Now, nil), Devices: registry, OnEvent: h.events.sink, Now: clock.Now,
	}
	h.server, err = New(h.config)
	if err != nil {
		t.Fatal(err)
	}
	h.server.pairFailureGrace = 20 * time.Millisecond
	return h
}

func (h *edgeHarness) start(t *testing.T, listener transport.Listener) {
	t.Helper()
	h.served = make(chan error, 1)
	go func() { h.served <- h.server.Serve(listener) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		_ = h.server.Close(ctx)
		select {
		case <-h.served:
		case <-time.After(testTimeout):
			t.Error("Serve did not return after Close")
		}
	})
}

func newEdge(t *testing.T, bridgeURL string) *edgeHarness {
	t.Helper()
	h := prepareEdge(t, bridgeURL)
	h.listener = newFakeListener(h.config.Devices)
	h.start(t, h.listener)
	return h
}

func (h *edgeHarness) beginPairing(t *testing.T) (string, string) {
	t.Helper()
	active, err := h.config.Sessions.Begin(pairing.Payload{Desktop: h.config.Desktop, Onion: h.onion}, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := pairing.Decode(active.Payload)
	if err != nil {
		t.Fatal(err)
	}
	return active.PairID, payload.Secret
}

func (h *edgeHarness) pairDevice(t *testing.T, key string) (pairing.Device, string) {
	t.Helper()
	device, token, err := h.config.Devices.Pair(pairing.DeviceInput{
		Name: "iPhone de Foco", Model: "iPhone16,1", Platform: "ios", App: "1.0.0",
		DeviceKey: key, Transport: transport.NameDirect, RemoteAddr: "192.168.15.40:51234",
	})
	if err != nil {
		t.Fatal(err)
	}
	return device, token
}

func pairBody(pairID, secret, key string) []byte {
	raw, _ := json.Marshal(map[string]any{"v": 2, "pairId": pairID, "secret": secret, "device": map[string]any{
		"name": "iPhone de Foco", "model": "iPhone16,1", "platform": "ios", "app": "1.0.0", "publicKey": key,
	}})
	return raw
}

// client speaks HTTP to the edge through streams of one session only.
func client(t *testing.T, session *fakeSession) *http.Client {
	t.Helper()
	roundTripper := &http.Transport{
		DialContext:        func(context.Context, string, string) (net.Conn, error) { return session.dial() },
		DisableCompression: true,
	}
	t.Cleanup(roundTripper.CloseIdleConnections)
	// No Client.Timeout: it would hide the writable body of an HTTP 101.
	return &http.Client{Transport: roundTripper}
}

func send(t *testing.T, httpClient *http.Client, method, path string, body []byte, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, "http://edge"+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response, data
}

func upgradeHeaders(token string) map[string]string {
	headers := map[string]string{"Connection": "Upgrade", "Upgrade": "websocket", "Origin": "http://127.0.0.1:47400"}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	return headers
}

// upgrade opens /pty and returns the upgraded connection on HTTP 101.
func upgrade(t *testing.T, httpClient *http.Client, token string, extra map[string]string) (*http.Response, io.ReadWriteCloser, []byte) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, "http://edge/pty", nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range upgradeHeaders(token) {
		request.Header.Set(name, value)
	}
	for name, value := range extra {
		request.Header.Set(name, value)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response, nil, data
	}
	conn, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		t.Fatal("upgraded body is not writable")
	}
	t.Cleanup(func() { _ = conn.Close() })
	return response, conn, nil
}

func expectEcho(t *testing.T, conn io.ReadWriter) {
	t.Helper()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	echoed := make([]byte, 4)
	if _, err := io.ReadFull(conn, echoed); err != nil || string(echoed) != "ping" {
		t.Fatalf("bridge echo failed: %q %v", echoed, err)
	}
}

func expectProblem(t *testing.T, response *http.Response, body []byte, status int, code string) {
	t.Helper()
	var problem struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &problem)
	if response.StatusCode != status || problem.Error.Code != code {
		t.Fatalf("got HTTP %d %s, want %d %s", response.StatusCode, body, status, code)
	}
}

// newBridge answers WebSocket upgrades with 101 and echoes the upgraded bytes.
func newBridge(t *testing.T) (string, chan http.Header) {
	t.Helper()
	observed := make(chan http.Header, 32)
	bridge := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		select {
		case observed <- request.Header.Clone():
		default:
		}
		if !isUpgrade(request) {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		conn, buffered, err := response.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buffered.Flush()
		go func() {
			defer conn.Close()
			_, _ = io.Copy(conn, buffered)
		}()
	}))
	t.Cleanup(bridge.Close)
	return bridge.URL, observed
}

func TestUnregisteredSessionOnlyReachesPairAndTheSameSessionOpensPty(t *testing.T) {
	bridgeURL, observed := newBridge(t)
	h := newEdge(t, bridgeURL)
	key := phoneKey(t)
	session := h.listener.open(key, transport.NameDirect, "192.168.15.40:51234", false)
	phone := client(t, session)

	for _, path := range []string{"/api/health", "/", "/assets/app.js", "/api/unknown"} {
		response, body := send(t, phone, http.MethodGet, path, nil, nil)
		expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")
	}
	response, _, body := upgrade(t, phone, "", nil)
	expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")
	response, body = send(t, phone, http.MethodGet, "/pair", nil, nil)
	expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")

	pairID, secret := h.beginPairing(t)
	response, body = send(t, phone, http.MethodPost, "/pair", pairBody(pairID, secret, key), nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pair failed: HTTP %d %s", response.StatusCode, body)
	}
	var result struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
		Desktop  struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			PublicKey string `json:"publicKey"`
		} `json:"desktop"`
		Reach    ReachCard `json:"reach"`
		IssuedAt string    `json:"issuedAt"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.DeviceID == "" || !strings.HasPrefix(result.Token, "cdt1.") || result.IssuedAt == "" {
		t.Fatalf("bad pair result: %s %v", body, err)
	}
	if result.Desktop.ID != h.config.Desktop.ID || result.Desktop.PublicKey != h.config.Desktop.PublicKey ||
		result.Reach.Onion != h.onion || result.Reach.PublicKey != h.config.Desktop.PublicKey || len(result.Reach.Candidates) != 1 {
		t.Fatalf("bad desktop or reach card: %s", body)
	}
	if !session.Registered() {
		t.Fatal("pairing did not promote the session")
	}
	device, ok := h.config.Devices.Get(result.DeviceID)
	if !ok || device.DeviceKey != key || device.LastTransport != transport.NameDirect || device.LastRemoteAddr != "192.168.15.40:51234" {
		t.Fatalf("device not recorded from the session: %#v", device)
	}
	h.events.wait(t, "pair.completed", func(data any) bool {
		fields := data.(map[string]any)
		return fields["transport"] == transport.NameDirect && fields["promoted"] == true
	})

	response, body = send(t, phone, http.MethodGet, "/api/health", nil, nil)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"service":"cialai"`) {
		t.Fatalf("registered session did not reach health: HTTP %d %s", response.StatusCode, body)
	}
	response, conn, body := upgrade(t, phone, result.Token, map[string]string{"X-Cialai-Device-Id": "spoofed", "X-Cialai-Proxy-Secret": "spoofed"})
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("same session could not open /pty: HTTP %d %s", response.StatusCode, body)
	}
	expectEcho(t, conn)
	var headers http.Header
	for headers == nil || headers.Get("Upgrade") == "" {
		select {
		case headers = <-observed:
		case <-time.After(testTimeout):
			t.Fatal("bridge did not receive the upgrade")
		}
	}
	if headers.Get("X-Cialai-Proxy-Secret") != "bridge-secret" || headers.Get("X-Cialai-Device-Id") != result.DeviceID ||
		headers.Get("X-Cialai-Device-Key") != key || headers.Get("X-Cialai-Node-Key") != key || headers.Get("X-Cialai-Transport") != transport.NameDirect {
		t.Fatalf("trusted headers missing: %#v", headers)
	}
	if headers.Get("Authorization") != "" || headers.Get("Origin") != "http://127.0.0.1:47400" {
		t.Fatalf("credentials leaked or Origin lost: %#v", headers)
	}
	h.events.wait(t, "session.opened", func(data any) bool {
		fields := data.(map[string]string)
		return fields["deviceId"] == result.DeviceID && fields["transport"] == transport.NameDirect && fields["deviceKey"] == key
	})

	response, body = send(t, phone, http.MethodPost, "/pair", pairBody(pairID, secret, key), nil)
	expectProblem(t, response, body, http.StatusGone, "pair_consumed")
	if len(h.listener.sessionsOf(key)) != 1 {
		t.Fatal("the phone used more than one transport session")
	}
}

func TestPairRefusesAPublicKeyDifferentFromTheSession(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:3720")
	key, declared := phoneKey(t), phoneKey(t)
	session := h.listener.open(key, transport.NameTor, "127.0.0.1:40123", false)
	pairID, secret := h.beginPairing(t)

	response, body := send(t, client(t, session), http.MethodPost, "/pair", pairBody(pairID, secret, declared), nil)
	expectProblem(t, response, body, http.StatusForbidden, "pair_key_mismatch")
	if !response.Close {
		t.Fatal("a failed pairing kept the HTTP connection open")
	}
	if len(h.config.Devices.List()) != 0 {
		t.Fatal("a mismatched key was registered")
	}
	if _, err := h.config.Sessions.Verify(pairID, secret); err != nil {
		t.Fatalf("a mismatched key burned the pairing session: %v", err)
	}
	select {
	case <-session.Done():
	case <-time.After(testTimeout):
		t.Fatal("a failed pairing did not close the unregistered session")
	}
	h.events.wait(t, "pair.failed", func(data any) bool {
		fields := data.(map[string]string)
		return fields["code"] == "pair_key_mismatch" && fields["transport"] == transport.NameTor
	})
}

func TestPairRateLimitIsFivePerMinutePerOrigin(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:3720")
	for attempt := 1; attempt <= 6; attempt++ {
		key := phoneKey(t)
		session := h.listener.open(key, transport.NameDirect, "192.168.15.40:5000"+string(rune('0'+attempt)), false)
		response, body := send(t, client(t, session), http.MethodPost, "/pair", pairBody("p_unknown00", "wrong", key), nil)
		if attempt <= MaxPairingsPerMin && response.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("pairing request %d was limited too early", attempt)
		}
		if attempt == MaxPairingsPerMin+1 {
			expectProblem(t, response, body, http.StatusTooManyRequests, "pair_rate_limited")
		}
	}
	key := phoneKey(t)
	other := h.listener.open(key, transport.NameDirect, "192.168.15.41:50000", false)
	response, _ := send(t, client(t, other), http.MethodPost, "/pair", pairBody("p_unknown00", "wrong", key), nil)
	if response.StatusCode == http.StatusTooManyRequests {
		t.Fatal("the limit of one origin affected another")
	}

	h.clock.Advance(time.Minute)
	key = phoneKey(t)
	later := h.listener.open(key, transport.NameDirect, "192.168.15.40:50009", false)
	response, _ = send(t, client(t, later), http.MethodPost, "/pair", pairBody("p_unknown00", "wrong", key), nil)
	if response.StatusCode == http.StatusTooManyRequests {
		t.Fatal("the pairing window did not reset after a minute")
	}
}

func TestSocketLimitsAreTwoPerDeviceAndEightInTotal(t *testing.T) {
	bridgeURL, _ := newBridge(t)
	h := newEdge(t, bridgeURL)
	key := phoneKey(t)
	_, token := h.pairDevice(t, key)
	session := h.listener.open(key, transport.NameDirect, "192.168.15.40:51234", true)
	phone := client(t, session)

	var held []io.ReadWriteCloser
	for index := range MaxDeviceSockets {
		response, conn, body := upgrade(t, phone, token, nil)
		if response.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("socket %d refused: HTTP %d %s", index+1, response.StatusCode, body)
		}
		expectEcho(t, conn)
		held = append(held, conn)
	}
	response, _, body := upgrade(t, phone, token, nil)
	expectProblem(t, response, body, http.StatusTooManyRequests, "socket_limit")

	_ = held[0].Close()
	deadline := time.Now().Add(testTimeout)
	for {
		response, conn, _ := upgrade(t, phone, token, nil)
		if response.StatusCode == http.StatusSwitchingProtocols {
			expectEcho(t, conn)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a closed socket never released its slot")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The global limit counts every device.
	server := prepareEdge(t, "http://127.0.0.1:3720").server
	var releases []func()
	for index := range MaxBridgeSockets {
		left, right := net.Pipe()
		t.Cleanup(func() { _ = left.Close(); _ = right.Close() })
		release, ok := server.acquire("dev_"+string(rune('a'+index)), left)
		if !ok {
			t.Fatalf("socket %d refused before the global limit", index+1)
		}
		releases = append(releases, release)
	}
	extra, _ := net.Pipe()
	defer extra.Close()
	if _, ok := server.acquire("dev_extra", extra); ok {
		t.Fatal("ninth bridge socket accepted")
	}
	for _, release := range releases {
		release()
	}
	if release, ok := server.acquire("dev_extra", extra); !ok {
		t.Fatal("released sockets were not returned to the pool")
	} else {
		release()
	}
}

func TestTorSessionIsMarkedSeenAndReportedWithItsTransport(t *testing.T) {
	bridgeURL, observed := newBridge(t)
	h := newEdge(t, bridgeURL)
	key := phoneKey(t)
	device, token := h.pairDevice(t, key)
	session := h.listener.open(key, transport.NameTor, "127.0.0.1:40123", true)

	response, conn, body := upgrade(t, client(t, session), token, nil)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("tor upgrade failed: HTTP %d %s", response.StatusCode, body)
	}
	expectEcho(t, conn)
	seen, _ := h.config.Devices.Get(device.ID)
	if seen.LastTransport != transport.NameTor || seen.LastRemoteAddr != "" {
		t.Fatalf("tor session not marked seen: %#v", seen)
	}
	h.events.wait(t, "session.opened", func(data any) bool {
		fields := data.(map[string]string)
		return fields["transport"] == transport.NameTor && fields["remoteAddr"] == ""
	})
	select {
	case headers := <-observed:
		if headers.Get("X-Cialai-Transport") != transport.NameTor {
			t.Fatalf("bridge did not learn the transport: %#v", headers)
		}
	case <-time.After(testTimeout):
		t.Fatal("bridge did not receive the upgrade")
	}
}

func TestUpgradeRefusesATokenOfAnotherDeviceKey(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:3720")
	owner, intruder := phoneKey(t), phoneKey(t)
	_, ownerToken := h.pairDevice(t, owner)
	h.pairDevice(t, intruder)
	session := h.listener.open(intruder, transport.NameDirect, "192.168.15.50:51234", true)

	response, _, body := upgrade(t, client(t, session), ownerToken, nil)
	expectProblem(t, response, body, http.StatusForbidden, "device_identity_mismatch")
	response, _, body = upgrade(t, client(t, session), "", nil)
	expectProblem(t, response, body, http.StatusUnauthorized, "device_unauthorized")
}

func TestRevokeClosesTheKeyOnEveryListenerAndBlocksTheSession(t *testing.T) {
	bridgeURL, _ := newBridge(t)
	h := prepareEdge(t, bridgeURL)
	direct, tor := newFakeListener(h.config.Devices), newFakeListener(h.config.Devices)
	h.start(t, transport.NewMultiListener(direct, tor))
	key, other := phoneKey(t), phoneKey(t)
	device, token := h.pairDevice(t, key)
	h.pairDevice(t, other)

	torSession := tor.open(key, transport.NameTor, "127.0.0.1:40123", true)
	directSession := direct.open(key, transport.NameDirect, "192.168.15.40:51234", true)
	survivor := direct.open(other, transport.NameDirect, "192.168.15.41:51234", true)
	response, conn, body := upgrade(t, client(t, torSession), token, nil)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade failed: HTTP %d %s", response.StatusCode, body)
	}
	expectEcho(t, conn)
	if response, _ := send(t, client(t, directSession), http.MethodGet, "/api/health", nil, nil); response.StatusCode != http.StatusOK {
		t.Fatal("direct session was not serving before the revocation")
	}

	result, err := h.server.Revoke(device.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Sessions != 2 || !torSession.closed() || !directSession.closed() || survivor.closed() {
		t.Fatalf("revocation closed the wrong sessions: %+v", result)
	}
	for _, listener := range []*fakeListener{direct, tor} {
		if keys := listener.closedKeys(); len(keys) != 1 || keys[0] != key {
			t.Fatalf("CloseKey did not reach every listener: %v", keys)
		}
	}
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("the bridge socket stayed open after revocation")
	}
	if revoked, _ := h.config.Devices.Get(device.ID); !revoked.Revoked {
		t.Fatal("device was not revoked in the registry")
	}
	h.events.wait(t, "session.closed", func(data any) bool {
		fields := data.(map[string]string)
		return fields["deviceId"] == device.ID && fields["reason"] == "revoked"
	})

	// A session admitted before the revocation reached the transport is
	// still refused by the edge.
	stale := direct.open(key, transport.NameDirect, "192.168.15.40:51235", true)
	response, body = send(t, client(t, stale), http.MethodGet, "/api/health", nil, nil)
	expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")
	if _, err := h.server.Revoke("dev_missing"); err == nil {
		t.Fatal("revoked an unknown device")
	}
}

func TestKeyRegisteredThroughAnotherSessionIsPromotedOnItsNextRequest(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:3720")
	key := phoneKey(t)
	session := h.listener.open(key, transport.NameDirect, "192.168.15.40:51234", false)
	phone := client(t, session)
	response, body := send(t, phone, http.MethodGet, "/api/health", nil, nil)
	expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")

	h.pairDevice(t, key)
	if response, _ := send(t, phone, http.MethodGet, "/api/health", nil, nil); response.StatusCode != http.StatusOK || !session.Registered() {
		t.Fatalf("registered key was not promoted: HTTP %d", response.StatusCode)
	}
}

func TestRequestsWithoutATransportSessionArePairRequired(t *testing.T) {
	h := prepareEdge(t, "http://127.0.0.1:3720")
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "http://edge/api/health", nil),
		httptest.NewRequest(http.MethodPost, "http://edge/pair", strings.NewReader("{}")),
	} {
		response := httptest.NewRecorder()
		h.server.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "pair_required") {
			t.Fatalf("request without a session reached %s: HTTP %d", request.URL.Path, response.Code)
		}
	}
}

func TestStaticContentTypesDoNotDependOnTheSystemRegistry(t *testing.T) {
	for name, want := range map[string]string{
		"assets/app.js":    "text/javascript; charset=utf-8",
		"assets/APP.CSS":   "text/css; charset=utf-8",
		"mobile.html":      "text/html; charset=utf-8",
		"fonts/mono.woff2": "font/woff2",
	} {
		if got := staticContentType(name); got != want {
			t.Fatalf("content type for %s: got %q, want %q", name, got, want)
		}
	}
}

func TestStaticSiteAndHealthAreConfinedAndHardened(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:3720")
	key := phoneKey(t)
	h.pairDevice(t, key)
	phone := client(t, h.listener.open(key, transport.NameDirect, "192.168.15.40:51234", true))
	if runtime.GOOS != "windows" {
		outside := filepath.Join(t.TempDir(), "outside.txt")
		_ = os.WriteFile(outside, []byte("outside"), 0o600)
		if err := os.Symlink(outside, filepath.Join(h.config.StaticDir, "assets", "escape.txt")); err != nil {
			t.Fatal(err)
		}
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
		{"/assets%5Capp.js", 404, "", "", ""},
		{"/assets/escape.txt", 404, "", "", ""},
		{"/api/health", 200, "no-store", `"service":"cialai"`, "application/json"},
	} {
		t.Run(test.path, func(t *testing.T) {
			response, body := send(t, phone, http.MethodGet, test.path, nil, nil)
			if response.StatusCode != test.status || (test.contains != "" && !strings.Contains(string(body), test.contains)) {
				t.Fatalf("unexpected response: HTTP %d %q", response.StatusCode, body)
			}
			if strings.Contains(string(body), "outside") || strings.Contains(string(body), "bridge-secret") {
				t.Fatal("response leaked a file or secret")
			}
			if test.cache != "" && response.Header.Get("Cache-Control") != test.cache {
				t.Fatalf("unexpected cache header: %q", response.Header.Get("Cache-Control"))
			}
			if test.contentType != "" && !strings.HasPrefix(response.Header.Get("Content-Type"), test.contentType) {
				t.Fatalf("unexpected content type: %q", response.Header.Get("Content-Type"))
			}
			if response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Content-Security-Policy") == "" {
				t.Fatal("security headers missing")
			}
		})
	}
}

func TestSuccessfulUpgradeOffersAThirtyDayTokenRotation(t *testing.T) {
	h := prepareEdge(t, "http://127.0.0.1:3720")
	device, oldToken := h.pairDevice(t, phoneKey(t))
	h.clock.Advance(31 * 24 * time.Hour)
	request := httptest.NewRequest(http.MethodGet, "http://edge/pty", nil)
	request = request.WithContext(context.WithValue(request.Context(), bridgeIdentityKey{}, bridgeIdentity{Device: device, Transport: transport.NameDirect}))
	response := &http.Response{StatusCode: http.StatusSwitchingProtocols, Header: make(http.Header), Request: request}
	if err := h.server.proxy.ModifyResponse(response); err != nil {
		t.Fatal(err)
	}
	newToken := response.Header.Get("X-Cialai-Token-Next")
	if newToken == "" || newToken == oldToken {
		t.Fatal("upgrade did not offer a rotated token")
	}
	if _, ok := h.config.Devices.Authenticate(oldToken); !ok {
		t.Fatal("old token lost its 24-hour grace window")
	}
	if _, ok := h.config.Devices.Authenticate(newToken); !ok {
		t.Fatal("new token was not persisted")
	}
}

func TestConfigRejectsUnsafeBridgeAndMissingDependencies(t *testing.T) {
	base := prepareEdge(t, "http://127.0.0.1:3720").config
	for name, mutate := range map[string]func(*Config){
		"non-loopback bridge": func(config *Config) { config.BridgeURL = "http://example.com:3720" },
		"missing secret":      func(config *Config) { config.ProxySecret = "" },
		"missing reach":       func(config *Config) { config.Reach = nil },
		"missing registry":    func(config *Config) { config.Devices = nil },
		"invalid desktop key": func(config *Config) { config.Desktop.PublicKey = "not-a-key" },
	} {
		config := base
		mutate(&config)
		if _, err := New(config); err == nil {
			t.Fatalf("accepted a config with %s", name)
		}
	}
}

func TestServeReportsAStoppedListenerAndCloseEndsIt(t *testing.T) {
	h := prepareEdge(t, "http://127.0.0.1:3720")
	listener := newFakeListener(h.config.Devices)
	served := make(chan error, 1)
	go func() { served <- h.server.Serve(listener) }()
	time.Sleep(20 * time.Millisecond)
	_ = listener.Close()
	select {
	case err := <-served:
		if !errors.Is(err, transport.ErrClosed) {
			t.Fatalf("Serve returned %v, want the listener error", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Serve kept running without a listener")
	}
	if err := h.server.Serve(newFakeListener(h.config.Devices)); err == nil {
		t.Fatal("a second Serve was accepted")
	}

	h = prepareEdge(t, "http://127.0.0.1:3720")
	listener = newFakeListener(h.config.Devices)
	go func() { served <- h.server.Serve(listener) }()
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := h.server.Close(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("Serve after Close returned %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Serve did not return after Close")
	}
	select {
	case <-listener.closing:
	default:
		t.Fatal("Close did not close the transport listener")
	}
}
