// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

const qrTestName = "Broto do Escritório"

// qrTor is a fake Tor that also publishes the temporary onion services of the
// pairings by QR; the test marks their descriptors uploaded.
type qrTor struct {
	*fakeTor
	mu        sync.Mutex
	published map[string]bool
	added     []string
	removed   []string
}

func (fake *qrTor) AddEphemeral(seed [32]byte) (string, error) {
	key, err := tor.OnionKeyFromSeed(seed[:])
	if err != nil {
		return "", err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if _, exists := fake.published[key.Address()]; !exists {
		fake.published[key.Address()] = false
		fake.added = append(fake.added, key.Address())
	}
	return key.Address(), nil
}

func (fake *qrTor) RemoveEphemeral(address string) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	delete(fake.published, address)
	fake.removed = append(fake.removed, address)
	return nil
}

func (fake *qrTor) EphemeralPublished(address string) bool {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.published[address]
}

func (fake *qrTor) upload(address string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if _, exists := fake.published[address]; exists {
		fake.published[address] = true
	}
}

func (fake *qrTor) temporary() ([]string, []string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return slices.Clone(fake.added), slices.Clone(fake.removed)
}

// qrAnnouncers records every announcer the network creates: the desktop one
// and the markers of the pairings by QR.
type qrAnnouncers struct {
	mu      sync.Mutex
	configs []AnnouncerConfig
	list    []*fakeAnnouncer
}

func (record *qrAnnouncers) start(config AnnouncerConfig) (Announcer, error) {
	announcer := &fakeAnnouncer{}
	record.mu.Lock()
	defer record.mu.Unlock()
	record.configs = append(record.configs, config)
	record.list = append(record.list, announcer)
	return announcer, nil
}

// marker returns the announcer created for key, or nil.
func (record *qrAnnouncers) marker(key ed25519.PublicKey) (*fakeAnnouncer, AnnouncerConfig) {
	record.mu.Lock()
	defer record.mu.Unlock()
	for index, config := range record.configs {
		if bytes.Equal(config.PublicKey, key) {
			return record.list[index], config
		}
	}
	return nil, AnnouncerConfig{}
}

func (record *qrAnnouncers) markerClosed(key ed25519.PublicKey) bool {
	marker, _ := record.marker(key)
	if marker == nil {
		return false
	}
	_, closed := marker.snapshot()
	return closed
}

// shortenQRLinger must run before startHarness, so the sidecar has stopped
// when the value comes back.
func shortenQRLinger(t *testing.T) {
	previous := qrLinger
	qrLinger = 50 * time.Millisecond
	t.Cleanup(func() { qrLinger = previous })
}

func waitUntil(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func expectCode(t *testing.T, response frame, code string) {
	t.Helper()
	if response.OK || response.Error == nil || response.Error.Code != code {
		t.Fatalf("want error %s, got ok=%v %+v %s", code, response.OK, response.Error, response.Result)
	}
}

func newTestQR(t *testing.T, broto *identity.Identity, expiresAt time.Time) (pairing.QR, string, pairing.QRKeys) {
	t.Helper()
	qr, err := pairing.NewQR(broto.PublicKey(), qrTestName, "linux", expiresAt, nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := pairing.EncodeQR(qr)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := qr.Derive()
	if err != nil {
		t.Fatal(err)
	}
	return qr, payload, keys
}

func qrStateOf(t *testing.T, h *harness, qrID string) qrStateResult {
	t.Helper()
	var state qrStateResult
	h.call(t, "broto.qr.state", map[string]any{"qrId": qrID}, &state)
	return state
}

// waitQRChanged waits for broto.qr.changed of qrID in stage.
func waitQRChanged(t *testing.T, h *harness, qrID, stage string) {
	t.Helper()
	h.waitEvent(t, "broto.qr.changed", 0, testTimeout, func(data json.RawMessage) bool {
		var event struct {
			QRID  string `json:"qrId"`
			Stage string `json:"stage"`
		}
		return json.Unmarshal(data, &event) == nil && event.QRID == qrID && event.Stage == stage
	})
}

// qrBroto claims a pairing by QR over the direct listener the way the Broto
// does on the local network path: a restricted session carries one stream, so
// every claim dials again; the first dial records the host key and the next
// ones pin it.
type qrBroto struct {
	identity *identity.Identity
	endpoint *direct.Endpoint
	address  netip.AddrPort
	hostKey  ed25519.PublicKey
}

func newQRBroto(t *testing.T, broto *identity.Identity, port int) *qrBroto {
	t.Helper()
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: socket, Identity: broto})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	return &qrBroto{identity: broto, endpoint: endpoint, address: netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(port))}
}

func (broto *qrBroto) claim(t *testing.T, keys pairing.QRKeys, nonce []byte, confirmed bool) (int, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	var session transport.Session
	var err error
	if broto.hostKey == nil {
		session, broto.hostKey, err = broto.endpoint.DialCandidatesRecord(ctx, []netip.AddrPort{broto.address})
	} else {
		session, err = broto.endpoint.DialCandidates(ctx, []netip.AddrPort{broto.address}, broto.hostKey)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	stream, err := session.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	body, _ := json.Marshal(map[string]any{
		"v": 2, "kind": "broto-qr", "pairId": keys.PairID, "secret": keys.PairSecret,
		"nonce": base64.RawURLEncoding.EncodeToString(nonce), "confirmed": confirmed,
		"device": map[string]string{"name": "broto", "model": "amd64", "platform": "linux", "app": "broto-1", "publicKey": broto.identity.PublicKeyString()},
	})
	request, err := http.NewRequest(http.MethodPost, "http://cialai/pair", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	_ = stream.SetDeadline(time.Now().Add(testTimeout))
	if err := request.Write(stream); err != nil {
		t.Fatalf("write /pair: %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(stream), request)
	if err != nil {
		t.Fatalf("read /pair: %v", err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}

func TestBrotoQRPairsAfterThePhoneApprovesAndTheBrotoConfirms(t *testing.T) {
	shortenQRLinger(t)
	announcers := &qrAnnouncers{}
	started := make(chan *qrTor, 1)
	h := startHarness(t, harnessOptions{
		torExecutable: "tor-test", announcer: announcers.start,
		startTor: func(config tor.DesktopConfig) (TorService, error) {
			fake, err := startFakeTor(config)
			if err != nil {
				return nil, err
			}
			temporary := &qrTor{fakeTor: fake, published: map[string]bool{}}
			started <- temporary
			return temporary, nil
		},
	})
	status := h.start(t, map[string]any{"stun": []string{}})
	onions := <-started
	brotoIdentity, err := identity.Generate(identity.RoleBroto, nil)
	if err != nil {
		t.Fatal(err)
	}
	qr, payload, keys := newTestQR(t, brotoIdentity, time.Now().Add(pairing.QRTTL))
	expectCode(t, h.request("broto.qr.state", map[string]any{"qrId": keys.PairID}, testTimeout), "qr_unknown")

	var begun struct {
		QRID      string `json:"qrId"`
		Name      string `json:"name"`
		Platform  string `json:"platform"`
		ExpiresAt string `json:"expiresAt"`
	}
	h.call(t, "broto.qr.begin", map[string]any{"payload": payload, "requester": "p_phone"}, &begun)
	wantExpiry := time.Unix(qr.ExpiresAt, 0).Add(pairing.QRGrace).UTC().Format(time.RFC3339)
	if begun.QRID != keys.PairID || begun.Name != qrTestName || begun.Platform != "linux" || begun.ExpiresAt != wantExpiry {
		t.Fatalf("broto.qr.begin = %+v, want expiry %s", begun, wantExpiry)
	}
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": payload, "requester": "p_phone"}, testTimeout), "qr_used")

	// The marker is announced with the port of the direct listener and the
	// temporary service carries the onion key of the QR.
	waitUntil(t, "the marker announcement", func() bool { marker, _ := announcers.marker(keys.MarkerKey()); return marker != nil })
	if _, config := announcers.marker(keys.MarkerKey()); int(config.Port) != status.Direct.Port || config.Logf == nil {
		t.Fatalf("marker config: %+v", config)
	}
	onionKey, err := tor.OnionKeyFromSeed(keys.OnionSeed[:])
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the temporary onion service", func() bool { added, _ := onions.temporary(); return slices.Contains(added, onionKey.Address()) })
	if state := qrStateOf(t, h, keys.PairID); state.Stage != pairing.QRStageWaiting || state.Onion != qrOnionPublishing || state.Digits != "" || state.ExpiresAt != wantExpiry || state.Name != qrTestName {
		t.Fatalf("state before the upload: %+v", state)
	}
	onions.upload(onionKey.Address())
	waitQRChanged(t, h, keys.PairID, pairing.QRStageWaiting)
	if state := qrStateOf(t, h, keys.PairID); state.Onion != qrOnionReady {
		t.Fatalf("state after the upload: %+v", state)
	}
	expectCode(t, h.request("broto.qr.decide", map[string]any{"qrId": keys.PairID, "approve": true, "requester": "p_phone"}, testTimeout), "qr_not_ready")

	broto := newQRBroto(t, brotoIdentity, status.Direct.Port)
	nonce := bytes.Repeat([]byte{7}, pairing.QRNonceSize)
	if code, body := broto.claim(t, keys, nonce, false); code != http.StatusAccepted || strings.TrimSpace(string(body)) != `{"state":"waiting"}` {
		t.Fatalf("first claim: HTTP %d %s", code, body)
	}
	if identity.EncodePublicKey(broto.hostKey) != status.Desktop.PublicKey {
		t.Fatal("the Broto recorded another host key")
	}
	waitQRChanged(t, h, keys.PairID, pairing.QRStageVerify)
	secret, _ := qr.SecretBytes()
	digits := pairing.QRDigits(broto.hostKey, brotoIdentity.PublicKey(), secret, nonce)
	if state := qrStateOf(t, h, keys.PairID); state.Stage != pairing.QRStageVerify || state.Digits != digits {
		t.Fatalf("state after the claim: %+v, want digits %s", state, digits)
	}

	// Only the phone that read the QR decides.
	expectCode(t, h.request("broto.qr.decide", map[string]any{"qrId": keys.PairID, "approve": true, "requester": "p_other"}, testTimeout), "qr_unknown")
	expectCode(t, h.request("broto.qr.decide", map[string]any{"qrId": keys.PairID, "approve": true}, testTimeout), "qr_unknown")
	expectCode(t, h.request("broto.qr.decide", map[string]any{"qrId": keys.PairID, "requester": "p_phone"}, testTimeout), "args_invalid")
	var decided struct {
		Stage string `json:"stage"`
	}
	h.call(t, "broto.qr.decide", map[string]any{"qrId": keys.PairID, "approve": true, "requester": "p_phone"}, &decided)
	if decided.Stage != pairing.QRStageApproved {
		t.Fatalf("decide = %+v", decided)
	}
	waitQRChanged(t, h, keys.PairID, pairing.QRStageApproved)
	if listed := h.request("broto.list", map[string]any{}, testTimeout); strings.Contains(string(listed.Result), brotoIdentity.ID()) {
		t.Fatal("the approval of the phone alone registered the Broto")
	}

	code, body := broto.claim(t, keys, nonce, true)
	if code != http.StatusOK {
		t.Fatalf("confirmed claim: HTTP %d %s", code, body)
	}
	var paired pairResponse
	if err := json.Unmarshal(body, &paired); err != nil || paired.DeviceID != brotoIdentity.ID() || paired.Desktop.PublicKey != status.Desktop.PublicKey || paired.Desktop.ID != status.Desktop.ID || paired.Reach.PublicKey != status.Desktop.PublicKey {
		t.Fatalf("pairing answer %s: %v", body, err)
	}
	waitQRChanged(t, h, keys.PairID, pairing.QRStageDone)
	if state := qrStateOf(t, h, keys.PairID); state.Stage != pairing.QRStageDone || state.Digits != "" {
		t.Fatalf("state after the pairing: %+v", state)
	}
	var brotos []map[string]any
	h.call(t, "broto.list", map[string]any{}, &brotos)
	if len(brotos) != 1 || brotos[0]["id"] != brotoIdentity.ID() || brotos[0]["name"] != qrTestName || brotos[0]["platform"] != "linux" {
		t.Fatalf("broto.list = %+v", brotos)
	}

	// After the linger the paths close.
	waitUntil(t, "the paths to close", func() bool {
		_, removed := onions.temporary()
		return slices.Contains(removed, onionKey.Address()) && announcers.markerClosed(keys.MarkerKey())
	})
	waitUntil(t, "the onion state", func() bool { return qrStateOf(t, h, keys.PairID).Onion == qrOnionOff })
}

func TestBrotoQRSessionsEndByDenialExpiryAndNetworkStop(t *testing.T) {
	shortenQRLinger(t)
	announcers := &qrAnnouncers{}
	h := startHarness(t, harnessOptions{announcer: announcers.start})
	brotos := make([]*identity.Identity, 3)
	for index := range brotos {
		generated, err := identity.Generate(identity.RoleBroto, nil)
		if err != nil {
			t.Fatal(err)
		}
		brotos[index] = generated
	}
	// The host keeps a QR for QRGrace after the expiry it carries, so this
	// one ends a few seconds from now.
	_, expiringPayload, expiring := newTestQR(t, brotos[0], time.Now().Add(3*time.Second-pairing.QRGrace))
	_, deniedPayload, denied := newTestQR(t, brotos[1], time.Now().Add(pairing.QRTTL))
	_, laterPayload, later := newTestQR(t, brotos[2], time.Now().Add(pairing.QRTTL))
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": deniedPayload}, testTimeout), "net_not_ready")

	h.start(t, map[string]any{"stun": []string{}, "tor": false})
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": "CIALAIQ1.e30"}, testTimeout), "qr_invalid")
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": deniedPayload, "qrId": "x"}, testTimeout), "args_invalid")
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": deniedPayload, "requester": strings.Repeat("p", maxQRRequester+1)}, testTimeout), "args_invalid")
	h.call(t, "broto.qr.begin", map[string]any{"payload": expiringPayload}, nil)
	h.call(t, "broto.qr.begin", map[string]any{"payload": deniedPayload, "requester": "p_phone"}, nil)
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": laterPayload}, testTimeout), "qr_busy")
	if state := qrStateOf(t, h, denied.PairID); state.Stage != pairing.QRStageWaiting || state.Onion != qrOnionOff {
		t.Fatalf("state without Tor: %+v", state)
	}

	// The phone may deny before the Broto claims; the paths close after the
	// linger and the QR cannot be read again.
	var decided struct {
		Stage string `json:"stage"`
	}
	h.call(t, "broto.qr.decide", map[string]any{"qrId": denied.PairID, "approve": false, "requester": "p_phone"}, &decided)
	if decided.Stage != pairing.QRStageDenied {
		t.Fatalf("deny = %+v", decided)
	}
	waitQRChanged(t, h, denied.PairID, pairing.QRStageDenied)
	waitUntil(t, "the marker of the denied QR to close", func() bool { return announcers.markerClosed(denied.MarkerKey()) })
	expectCode(t, h.request("broto.qr.decide", map[string]any{"qrId": denied.PairID, "approve": false, "requester": "p_phone"}, testTimeout), "qr_not_ready")
	expectCode(t, h.request("broto.qr.begin", map[string]any{"payload": deniedPayload, "requester": "p_phone"}, testTimeout), "qr_used")
	h.call(t, "broto.qr.begin", map[string]any{"payload": laterPayload}, nil)

	waitQRChanged(t, h, expiring.PairID, pairing.QRStageExpired)
	waitUntil(t, "the marker of the expired QR to close", func() bool { return announcers.markerClosed(expiring.MarkerKey()) })
	if state := qrStateOf(t, h, expiring.PairID); state.Stage != pairing.QRStageExpired || state.Onion != qrOnionOff {
		t.Fatalf("expired state: %+v", state)
	}
	if announcers.markerClosed(later.MarkerKey()) {
		t.Fatal("a live QR lost its marker")
	}
	h.call(t, "net.refresh", map[string]any{}, nil)
	if marker, _ := announcers.marker(later.MarkerKey()); marker == nil {
		t.Fatal("the live QR has no marker")
	} else if refreshes, _ := marker.snapshot(); refreshes != 1 {
		t.Fatalf("marker refreshes = %d", refreshes)
	}
	h.call(t, "net.stop", map[string]any{}, nil)
	if !announcers.markerClosed(later.MarkerKey()) {
		t.Fatal("net.stop left the marker of a live QR")
	}
}
