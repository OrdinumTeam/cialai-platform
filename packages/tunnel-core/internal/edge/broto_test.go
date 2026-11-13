// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

func TestBrotoApprovalPollingDoesNotConsumePairAttemptQuota(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:1")
	key := mustIdentity(t, identity.RoleBroto).PublicKeyString()
	active, err := h.config.Sessions.BeginBroto(pairing.Payload{Desktop: h.config.Desktop, Onion: h.onion})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := pairing.DecodeBroto(active.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err = json.Unmarshal(pairBody(active.PairID, payload.Secret, key), &body); err != nil {
		t.Fatal(err)
	}
	body["kind"] = "broto"
	raw, _ := json.Marshal(body)
	c := client(t, h.listener.open(key, transport.NameDirect, "127.0.0.1:1234", false))
	for i := 0; i < 3*MaxPairingsPerMin; i++ {
		response, _ := send(t, c, http.MethodPost, "/pair", raw, nil)
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("valid poll %d: status %d", i, response.StatusCode)
		}
	}
	if len(h.config.Devices.List()) != 0 {
		t.Fatal("registered before approval")
	}
	if err = h.config.Sessions.DecideBroto(active.PairID, true); err != nil {
		t.Fatal(err)
	}
	response, _ := send(t, c, http.MethodPost, "/pair", raw, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("approved poll: status %d", response.StatusCode)
	}
}

func TestBrotoCannotReachHostRoutes(t *testing.T) {
	var calls atomic.Int32
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(200) }))
	defer bridge.Close()
	h := newEdge(t, bridge.URL)
	key := mustIdentity(t, identity.RoleBroto).PublicKeyString()
	_, token, err := h.config.Devices.Pair(pairing.DeviceInput{Kind: identity.RoleBroto, Name: "Broto", Model: "PC", Platform: "linux", App: "1", DeviceKey: key, Transport: transport.NameDirect})
	if err != nil {
		t.Fatal(err)
	}
	c := client(t, h.listener.open(key, transport.NameDirect, "127.0.0.1:1234", true))
	for _, path := range []string{"/pty", "/", "/api/health", "/assets/app.js", "/pair"} {
		response, _ := send(t, c, http.MethodGet, path, nil, upgradeHeaders(token))
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("%s: got %d, want 403", path, response.StatusCode)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("Broto reached host bridge")
	}
	for _, test := range []struct {
		token  string
		status int
	}{
		{"", http.StatusUnauthorized},
		{token, http.StatusServiceUnavailable},
	} {
		response, _ := send(t, c, http.MethodGet, "/broto", nil, upgradeHeaders(test.token))
		if response.StatusCode != test.status {
			t.Fatalf("reverse route: got %d, want %d", response.StatusCode, test.status)
		}
	}
	otherKey := mustIdentity(t, identity.RoleBroto).PublicKeyString()
	_, otherToken, err := h.config.Devices.Pair(pairing.DeviceInput{Kind: identity.RoleBroto, Name: "Other", Model: "PC", Platform: "linux", App: "1", DeviceKey: otherKey, Transport: transport.NameDirect})
	if err != nil {
		t.Fatal(err)
	}
	response, _ := send(t, c, http.MethodGet, "/broto", nil, upgradeHeaders(otherToken))
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("token accepted for another TLS key")
	}
	device, ok := h.config.Devices.RegisteredDevice(key)
	if !ok {
		t.Fatal("device missing")
	}
	if err := h.config.Devices.Revoke(device.ID); err != nil {
		t.Fatal(err)
	}
	response, _ = send(t, c, http.MethodGet, "/broto", nil, upgradeHeaders(token))
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("revoked Broto accepted")
	}
}

func TestPhoneCannotReachBrotoRoute(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:1")
	key := phoneKey(t)
	_, token := h.pairDevice(t, key)
	c := client(t, h.listener.open(key, transport.NameDirect, "127.0.0.1:1234", true))
	response, _ := send(t, c, http.MethodGet, "/broto", nil, upgradeHeaders(token))
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("got %d, want 403", response.StatusCode)
	}
}
