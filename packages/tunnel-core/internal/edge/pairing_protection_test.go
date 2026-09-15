// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

// The pairing protections of CON-060, verified over the real direct QUIC
// listener and the onion TLS listener on loopback, with the pairing clock
// under test control. Every refusal that reaches the edge answers with its
// code and emits pair.failed with the pairing id, the code and the
// transport; a refusal decided by the transport before the edge, when no
// pairing session is active, never reaches it and emits nothing.

// protection is one edge with both real listeners.
type protection struct {
	h         *edgeHarness
	listeners *realListeners
	name      string
}

// newProtection starts the edge; a non-nil approver turns approval on before
// the listeners serve.
func newProtection(t *testing.T, name string, approver Approver) *protection {
	t.Helper()
	bridgeURL, _ := newBridge(t)
	h := prepareEdge(t, bridgeURL)
	if approver != nil {
		h.server.config.Approver = approver
		h.server.config.RequireApproval = true
	}
	return &protection{h: h, listeners: startRealListeners(t, h), name: name}
}

// post sends POST /pair as phone, declaring key, on a new link of the
// transport under test. A refusal ends the restricted session of an
// unregistered phone, and post waits for that before returning.
func (p *protection) post(t *testing.T, phone *identity.Identity, pairID, secret, key string) (*http.Response, []byte) {
	t.Helper()
	_, registered := p.h.config.Devices.RegisteredKey(phone.PublicKeyString())
	link := p.listeners.link(t, p.name, phone)
	stream := link.openStream(t)
	client := newStreamClient(t, stream)
	response, body := client.do(t, http.MethodPost, "/pair", pairBody(pairID, secret, key), nil)
	if response.StatusCode == http.StatusOK || registered {
		return response, body
	}
	if !response.Close {
		t.Fatalf("the refusal of an unregistered phone kept the HTTP connection open: HTTP %d %s", response.StatusCode, body)
	}
	if link.session != nil {
		waitSessionDone(t, link.session)
	} else {
		expectConnDropped(t, stream)
	}
	return response, body
}

// pair pairs phone with its own key and fails the test on a refusal.
func (p *protection) pair(t *testing.T, phone *identity.Identity, pairID, secret string) {
	t.Helper()
	if response, body := p.post(t, phone, pairID, secret, phone.PublicKeyString()); response.StatusCode != http.StatusOK {
		t.Fatalf("pairing over %s refused: HTTP %d %s", p.name, response.StatusCode, body)
	}
}

// refuse posts and expects the status and code, then the pair.failed event.
func (p *protection) refuse(t *testing.T, phone *identity.Identity, pairID, secret, key string, status int, code string) {
	t.Helper()
	before := p.failures(pairID, code)
	response, body := p.post(t, phone, pairID, secret, key)
	expectProblem(t, response, body, status, code)
	deadline := time.Now().Add(testTimeout)
	for p.failures(pairID, code) == before {
		if time.Now().After(deadline) {
			t.Fatalf("no pair.failed with %s over %s", code, p.name)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// failures counts pair.failed events of pairID with code on this transport.
func (p *protection) failures(pairID, code string) int {
	p.h.events.mu.Lock()
	defer p.h.events.mu.Unlock()
	count := 0
	for _, event := range p.h.events.events {
		fields, ok := event.data.(map[string]string)
		if event.name == "pair.failed" && ok && fields["pairId"] == pairID && fields["code"] == code && fields["transport"] == p.name {
			count++
		}
	}
	return count
}

func (p *protection) allFailures() int {
	p.h.events.mu.Lock()
	defer p.h.events.mu.Unlock()
	count := 0
	for _, event := range p.h.events.events {
		if event.name == "pair.failed" {
			count++
		}
	}
	return count
}

// refusedBeforeEdge expects the transport to refuse an unregistered key while
// no pairing session is active: QUIC closes with the pairing inactive code,
// which the phone reports as pair_inactive, and the onion connection ends.
func (p *protection) refusedBeforeEdge(t *testing.T, phone *identity.Identity) {
	t.Helper()
	before := p.allFailures()
	if p.name == transport.NameDirect {
		session, err := p.listeners.dialDirect(t, phone)
		if err == nil {
			waitSessionDone(t, session)
			err = session.(*direct.Session).Err()
		}
		if !errors.Is(err, transport.ErrPairingInactive) {
			t.Fatalf("unregistered key without an active pairing: %v", err)
		}
	} else {
		expectConnDropped(t, p.listeners.dialOnion(t, phone))
	}
	if after := p.allFailures(); after != before {
		t.Fatalf("a refusal before the edge emitted pair.failed")
	}
}

func (p *protection) begin(t *testing.T, ttl time.Duration) (string, string) {
	t.Helper()
	active, err := p.h.config.Sessions.Begin(pairing.Payload{Desktop: p.h.config.Desktop, Onion: p.h.onion}, ttl)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := pairing.Decode(active.Payload)
	if err != nil {
		t.Fatal(err)
	}
	return active.PairID, payload.Secret
}

func (p *protection) devices() int { return len(p.h.config.Devices.List()) }

func TestPairingProtectionsOverRealDirectAndOnionListeners(t *testing.T) {
	for _, name := range []string{transport.NameDirect, transport.NameTor} {
		t.Run(name, func(t *testing.T) {
			t.Run("secret is single use", func(t *testing.T) { testSecretSingleUse(t, name) })
			t.Run("QR photo replayed after use", func(t *testing.T) { testQRPhotoReplay(t, name) })
			t.Run("expired QR", func(t *testing.T) { testExpiredQR(t, name) })
			t.Run("QR rotated after 90 s", func(t *testing.T) { testRotatedQR(t, name) })
			t.Run("five attempts per minute", func(t *testing.T) { testPairRateLimit(t, name) })
			t.Run("blocked after ten failures", func(t *testing.T) { testBlockedAfterTenFailures(t, name) })
			t.Run("approval denied or unanswered", func(t *testing.T) { testApprovalRefusals(t, name) })
			t.Run("TLS key different from the declared key", func(t *testing.T) { testDeclaredKeyMismatch(t, name) })
		})
	}
}

func testSecretSingleUse(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	phone := mustIdentity(t, identity.RolePhone)
	pairID, secret := p.begin(t, 10*time.Minute)
	p.pair(t, phone, pairID, secret)
	// The phone is registered now, so the transport lets it reach the edge.
	p.refuse(t, phone, pairID, secret, phone.PublicKeyString(), http.StatusGone, "pair_consumed")
	if p.devices() != 1 {
		t.Fatalf("a consumed secret registered %d devices", p.devices())
	}
}

func testQRPhotoReplay(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	owner, thief := mustIdentity(t, identity.RolePhone), mustIdentity(t, identity.RolePhone)
	pairID, secret := p.begin(t, 10*time.Minute)
	p.pair(t, owner, pairID, secret)
	// With the only QR used, another phone does not even get a pairing session.
	p.refusedBeforeEdge(t, thief)
	// The desktop shows a new QR: the photo of the old one reaches the edge
	// and is refused as consumed.
	p.begin(t, 10*time.Minute)
	p.refuse(t, thief, pairID, secret, thief.PublicKeyString(), http.StatusGone, "pair_consumed")
	if devices := p.h.config.Devices.List(); len(devices) != 1 || devices[0].DeviceKey != owner.PublicKeyString() {
		t.Fatalf("the replayed QR registered another phone: %+v", devices)
	}
}

func testExpiredQR(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	phone := mustIdentity(t, identity.RolePhone)
	pairID, secret := p.begin(t, 2*time.Minute)
	p.h.clock.Advance(2*time.Minute + time.Second)
	p.refusedBeforeEdge(t, phone)
	p.begin(t, 10*time.Minute)
	p.refuse(t, phone, pairID, secret, phone.PublicKeyString(), http.StatusGone, "pair_expired")
	if p.devices() != 0 {
		t.Fatal("an expired QR registered a phone")
	}
}

func testRotatedQR(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	phone := mustIdentity(t, identity.RolePhone)
	oldID, oldSecret := p.begin(t, 10*time.Minute)
	// The pairing dialog rotates the QR every 90 s with pair.cancel and
	// pair.begin.
	p.h.clock.Advance(90 * time.Second)
	if err := p.h.config.Sessions.Cancel(oldID); err != nil {
		t.Fatal(err)
	}
	newID, newSecret := p.begin(t, 10*time.Minute)
	p.refuse(t, phone, oldID, oldSecret, phone.PublicKeyString(), http.StatusNotFound, "pair_unknown")
	p.pair(t, phone, newID, newSecret)
}

func testPairRateLimit(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	pairID, secret := p.begin(t, 10*time.Minute)
	for attempt := 1; attempt <= MaxPairingsPerMin; attempt++ {
		phone := mustIdentity(t, identity.RolePhone)
		p.refuse(t, phone, pairID, "d3JvbmctZ3Vlc3Mtb2YtdGhlLXBhaXJpbmctc2VjcmV0", phone.PublicKeyString(), http.StatusUnauthorized, "pair_secret_mismatch")
	}
	phone := mustIdentity(t, identity.RolePhone)
	// Within the minute even the right secret is limited, before the secret
	// is checked, so the session keeps its failure count.
	p.refuse(t, phone, "", secret, phone.PublicKeyString(), http.StatusTooManyRequests, "pair_rate_limited")
	p.h.clock.Advance(time.Minute)
	p.pair(t, phone, pairID, secret)
}

func testBlockedAfterTenFailures(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	pairID, secret := p.begin(t, 10*time.Minute)
	for failure := 1; failure <= pairing.MaxSecretFailures; failure++ {
		if failure%MaxPairingsPerMin == 1 {
			// A new minute, so the rate limit does not hide the failures.
			p.h.clock.Advance(time.Minute)
		}
		phone := mustIdentity(t, identity.RolePhone)
		p.refuse(t, phone, pairID, "d3JvbmctZ3Vlc3Mtb2YtdGhlLXBhaXJpbmctc2VjcmV0", phone.PublicKeyString(), http.StatusUnauthorized, "pair_secret_mismatch")
	}
	phone := mustIdentity(t, identity.RolePhone)
	// The blocked session no longer counts as an active pairing.
	p.refusedBeforeEdge(t, phone)
	p.h.clock.Advance(time.Minute)
	p.begin(t, 10*time.Minute)
	p.refuse(t, phone, pairID, secret, phone.PublicKeyString(), http.StatusUnauthorized, "pair_secret_mismatch")
	if p.failures(pairID, "pair_secret_mismatch") != pairing.MaxSecretFailures+1 || p.devices() != 0 {
		t.Fatalf("blocked session: %d failures, %d devices", p.failures(pairID, "pair_secret_mismatch"), p.devices())
	}
}

// recordingApprover answers approvals with the next decision and records the
// requests, standing in for the four digit confirmation of the desktop, which
// internal/sidecar drives through pair.requested, pair.deny and pair.approve.
type recordingApprover struct {
	mu        sync.Mutex
	requests  []ApprovalRequest
	decisions []error
}

func (approver *recordingApprover) Await(ctx context.Context, request ApprovalRequest) error {
	approver.mu.Lock()
	defer approver.mu.Unlock()
	approver.requests = append(approver.requests, request)
	decision := approver.decisions[0]
	approver.decisions = approver.decisions[1:]
	return decision
}

func testApprovalRefusals(t *testing.T, name string) {
	approver := &recordingApprover{decisions: []error{
		pairing.NewError("pair_denied", "O pareamento foi recusado no computador."),
		pairing.NewError("pair_timeout", "O computador não respondeu ao pedido de pareamento."),
		nil,
	}}
	p := newProtection(t, name, approver)
	phone := mustIdentity(t, identity.RolePhone)
	pairID, secret := p.begin(t, 10*time.Minute)
	p.refuse(t, phone, pairID, secret, phone.PublicKeyString(), http.StatusForbidden, "pair_denied")
	p.refuse(t, phone, pairID, secret, phone.PublicKeyString(), http.StatusForbidden, "pair_timeout")
	// A denied or unanswered approval does not burn the QR.
	p.pair(t, phone, pairID, secret)
	approver.mu.Lock()
	defer approver.mu.Unlock()
	if len(approver.requests) != 3 {
		t.Fatalf("approvals asked %d times", len(approver.requests))
	}
	for _, request := range approver.requests {
		if request.PairID != pairID || request.Transport != name || request.Device.PublicKey != phone.PublicKeyString() {
			t.Fatalf("approval request %+v", request)
		}
	}
}

func testDeclaredKeyMismatch(t *testing.T, name string) {
	p := newProtection(t, name, nil)
	phone, declared := mustIdentity(t, identity.RolePhone), mustIdentity(t, identity.RolePhone)
	pairID, secret := p.begin(t, 10*time.Minute)
	p.refuse(t, phone, pairID, secret, declared.PublicKeyString(), http.StatusForbidden, "pair_key_mismatch")
	// The mismatch does not burn the QR for the phone that owns the key.
	p.pair(t, phone, pairID, secret)
	if devices := p.h.config.Devices.List(); len(devices) != 1 || devices[0].DeviceKey != phone.PublicKeyString() {
		t.Fatalf("registered %+v", devices)
	}

	// The other direction: a phone pinning another desktop key than the one
	// the listener proves ends the handshake on the phone, before the edge.
	before := p.allFailures()
	stranger := mustIdentity(t, identity.RoleDesktop)
	intruder := mustIdentity(t, identity.RolePhone)
	p.begin(t, 10*time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if name == transport.NameDirect {
		endpoint, err := direct.New(direct.Config{PacketConn: listenUDP(t), Identity: intruder})
		if err != nil {
			t.Fatal(err)
		}
		defer endpoint.Close()
		if session, err := endpoint.Dial(ctx, p.listeners.direct.Addr().String(), stranger.PublicKey()); err == nil {
			_ = session.Close()
			t.Fatal("QUIC accepted a desktop key other than the pinned one")
		}
	} else {
		config, err := identity.ClientConfig(intruder, stranger.PublicKey())
		if err != nil {
			t.Fatal(err)
		}
		if conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", p.listeners.onion.Addr().String()); err == nil {
			_ = conn.Close()
			t.Fatal("onion TLS accepted a desktop key other than the pinned one")
		}
	}
	if p.allFailures() != before {
		t.Fatal("a pin mismatch on the phone reached the edge")
	}
}
