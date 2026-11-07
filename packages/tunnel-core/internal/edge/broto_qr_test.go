// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const qrBrotoName = "Broto do Escritório"

// beginQR opens the host session of a QR shown by broto, as the sidecar does
// when a phone scans it.
func (h *edgeHarness) beginQR(t *testing.T, broto *identity.Identity) (pairing.QR, pairing.QRKeys) {
	t.Helper()
	qr, err := pairing.NewQR(broto.PublicKey(), qrBrotoName, "linux", h.clock.Now().Add(pairing.QRTTL), nil)
	if err != nil {
		t.Fatal(err)
	}
	text, err := pairing.EncodeQR(qr)
	if err != nil {
		t.Fatal(err)
	}
	_, keys, err := h.config.Sessions.BeginQR(text, h.config.Desktop, "")
	if err != nil {
		t.Fatal(err)
	}
	return qr, keys
}

func qrNonce(fill byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, pairing.QRNonceSize))
}

func qrClaimBody(keys pairing.QRKeys, key, nonce string, confirmed bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"v": 2, "kind": "broto-qr", "pairId": keys.PairID, "secret": keys.PairSecret, "nonce": nonce, "confirmed": confirmed,
		"device": map[string]any{"name": "Outro nome", "model": "amd64", "platform": "linux", "app": "broto-1", "publicKey": key},
	})
	return raw
}

func TestBrotoQRPairingNeedsThePhoneAndTheBrotoConfirmation(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:1")
	broto := mustIdentity(t, identity.RoleBroto)
	key := broto.PublicKeyString()
	qr, keys := h.beginQR(t, broto)
	c := client(t, h.listener.open(key, transport.NameDirect, "127.0.0.1:1234", false))
	claim := func(nonce string, confirmed bool) (*http.Response, []byte) {
		return send(t, c, http.MethodPost, "/pair", qrClaimBody(keys, key, nonce, confirmed), nil)
	}
	// Valid polls do not spend the pairing quota.
	for attempt := range 3 * MaxPairingsPerMin {
		response, body := claim(qrNonce(1), attempt > 0)
		if response.StatusCode != http.StatusAccepted || strings.TrimSpace(string(body)) != `{"state":"waiting"}` {
			t.Fatalf("poll %d: HTTP %d %s", attempt, response.StatusCode, body)
		}
	}
	view, err := h.config.Sessions.QRState(keys.PairID)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := qr.SecretBytes()
	nonce, _ := base64.RawURLEncoding.DecodeString(qrNonce(1))
	if want := pairing.QRDigits(h.desktop.PublicKey(), broto.PublicKey(), secret, nonce); view.Stage != pairing.QRStageVerify || view.Digits != want {
		t.Fatalf("host view = %+v, want digits %s", view, want)
	}
	if len(h.config.Devices.List()) != 0 {
		t.Fatal("the confirmation of the Broto alone registered it")
	}
	if _, err := h.config.Sessions.DecideQR(keys.PairID, true, ""); err != nil {
		t.Fatal(err)
	}
	// A new nonce clears the confirmation; only a confirmation of the current
	// nonce finishes.
	if response, _ := claim(qrNonce(2), true); response.StatusCode != http.StatusAccepted {
		t.Fatalf("new nonce: HTTP %d", response.StatusCode)
	}
	if len(h.config.Devices.List()) != 0 {
		t.Fatal("registered with the confirmation of a replaced nonce")
	}
	response, body := claim(qrNonce(2), true)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("confirmed claim: HTTP %d %s", response.StatusCode, body)
	}
	var answer struct {
		DeviceID string            `json:"deviceId"`
		Token    string            `json:"token"`
		Desktop  map[string]string `json:"desktop"`
		Reach    ReachCard         `json:"reach"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		t.Fatal(err)
	}
	if answer.DeviceID != broto.ID() || !strings.HasPrefix(answer.Token, "cbt1."+broto.ID()+".") ||
		answer.Desktop["publicKey"] != h.config.Desktop.PublicKey || answer.Desktop["id"] != h.config.Desktop.ID || answer.Reach.PublicKey != h.config.Desktop.PublicKey || answer.Reach.Onion != h.onion {
		t.Fatalf("pairing answer = %s", body)
	}
	device, ok := h.config.Devices.RegisteredDevice(key)
	if !ok || device.Kind != identity.RoleBroto || device.Name != qrBrotoName || device.Platform != "linux" || device.App != "broto-1" {
		t.Fatalf("registered device = %+v, %v", device, ok)
	}
	if _, ok := h.config.Devices.Authenticate(answer.Token); !ok {
		t.Fatal("the issued token does not authenticate")
	}
	h.events.wait(t, "devices.changed", func(data any) bool { return data.(map[string]any)["deviceId"] == broto.ID() })
	response, body = claim(qrNonce(2), true)
	expectProblem(t, response, body, http.StatusForbidden, "pair_invalid")
}

func TestBrotoQRPairingRefusesOtherKeysAndEndedSessions(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:1")
	broto := mustIdentity(t, identity.RoleBroto)
	_, keys := h.beginQR(t, broto)
	thief := mustIdentity(t, identity.RoleBroto)
	stolen := client(t, h.listener.open(thief.PublicKeyString(), transport.NameTor, "127.0.0.1:40123", false))
	response, body := send(t, stolen, http.MethodPost, "/pair", qrClaimBody(keys, thief.PublicKeyString(), qrNonce(1), false), nil)
	expectProblem(t, response, body, http.StatusForbidden, "pair_claimed")
	stolen = client(t, h.listener.open(thief.PublicKeyString(), transport.NameTor, "127.0.0.1:40124", false))
	response, body = send(t, stolen, http.MethodPost, "/pair", qrClaimBody(keys, broto.PublicKeyString(), qrNonce(1), false), nil)
	expectProblem(t, response, body, http.StatusForbidden, "pair_key_mismatch")
	if view, _ := h.config.Sessions.QRState(keys.PairID); view.Stage != pairing.QRStageWaiting {
		t.Fatalf("a refused key moved the session to %s", view.Stage)
	}

	c := client(t, h.listener.open(broto.PublicKeyString(), transport.NameDirect, "127.0.0.1:1234", false))
	if response, _ := send(t, c, http.MethodPost, "/pair", qrClaimBody(keys, broto.PublicKeyString(), qrNonce(1), false), nil); response.StatusCode != http.StatusAccepted {
		t.Fatalf("claim: HTTP %d", response.StatusCode)
	}
	if _, err := h.config.Sessions.DecideQR(keys.PairID, false, ""); err != nil {
		t.Fatal(err)
	}
	response, body = send(t, c, http.MethodPost, "/pair", qrClaimBody(keys, broto.PublicKeyString(), qrNonce(1), true), nil)
	expectProblem(t, response, body, http.StatusForbidden, "pair_denied")

	other := mustIdentity(t, identity.RoleBroto)
	_, expiring := h.beginQR(t, other)
	h.clock.Advance(pairing.QRTTL + pairing.QRGrace)
	late := client(t, h.listener.open(other.PublicKeyString(), transport.NameDirect, "127.0.0.1:1235", false))
	response, body = send(t, late, http.MethodPost, "/pair", qrClaimBody(expiring, other.PublicKeyString(), qrNonce(1), false), nil)
	expectProblem(t, response, body, http.StatusForbidden, "pair_expired")
	unknown := pairing.QRKeys{PairID: "q_AAAAAAAAAAAAAAAAAAAAAA", PairSecret: expiring.PairSecret}
	response, body = send(t, late, http.MethodPost, "/pair", qrClaimBody(unknown, other.PublicKeyString(), qrNonce(1), false), nil)
	expectProblem(t, response, body, http.StatusForbidden, "pair_unknown")
	if len(h.config.Devices.List()) != 0 {
		t.Fatal("a refused claim registered a device")
	}
}

func TestPairRejectsTheQRFieldsOnOtherKinds(t *testing.T) {
	h := newEdge(t, "http://127.0.0.1:1")
	pairID, secret := h.beginPairing(t)
	key := phoneKey(t)
	for name, extra := range map[string]map[string]any{
		"phone with nonce":     {"nonce": qrNonce(1)},
		"phone with confirmed": {"confirmed": true},
		"broto with nonce":     {"kind": "broto", "nonce": qrNonce(1)},
		"broto confirmed":      {"kind": "broto", "confirmed": true},
	} {
		t.Run(name, func(t *testing.T) {
			var body map[string]any
			_ = json.Unmarshal(pairBody(pairID, secret, key), &body)
			for field, value := range extra {
				body[field] = value
			}
			raw, _ := json.Marshal(body)
			session := h.listener.open(key, transport.NameDirect, "127.0.0.1:1234", false)
			response, problem := send(t, client(t, session), http.MethodPost, "/pair", raw, nil)
			expectProblem(t, response, problem, http.StatusBadRequest, "payload_invalid")
		})
	}
	if _, err := h.config.Sessions.Verify(pairID, secret); err != nil {
		t.Fatalf("a rejected request burned the pairing session: %v", err)
	}
}
