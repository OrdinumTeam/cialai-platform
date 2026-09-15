// SPDX-License-Identifier: Apache-2.0
package onion

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const testTimeout = 10 * time.Second

type fakeRegistry struct {
	mu   sync.Mutex
	keys map[string]string
}

func (registry *fakeRegistry) RegisteredKey(key string) (string, bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	id, ok := registry.keys[key]
	return id, ok
}

func (registry *fakeRegistry) register(phone *identity.Identity) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.keys[phone.PublicKeyString()] = phone.ID()
}

func (registry *fakeRegistry) revoke(phone *identity.Identity) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	delete(registry.keys, phone.PublicKeyString())
}

type fakeGate struct{ active atomic.Bool }

func (gate *fakeGate) PairingActive() bool { return gate.active.Load() }

// harness stands in for tor.Desktop: a loopback TCP listener whose
// connections the onion listener wraps in TLS, with no Tor involved.
type harness struct {
	desktop  *identity.Identity
	listener *Listener
	registry *fakeRegistry
	gate     *fakeGate
}

func newHarness(t *testing.T, config ListenConfig) *harness {
	t.Helper()
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{desktop: mustIdentity(t, identity.RoleDesktop), registry: &fakeRegistry{keys: make(map[string]string)}, gate: &fakeGate{}}
	config.Registry = h.registry
	config.Pairing = h.gate
	listener, err := Listen(raw, h.desktop, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	h.listener = listener
	return h
}

func mustIdentity(t *testing.T, role identity.Role) *identity.Identity {
	t.Helper()
	local, err := identity.Generate(role, nil)
	if err != nil {
		t.Fatal(err)
	}
	return local
}

func (h *harness) dial(t *testing.T, phone *identity.Identity) *tls.Conn {
	t.Helper()
	config, err := identity.ClientConfig(phone, h.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", h.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial onion listener: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn.(*tls.Conn)
}

func (h *harness) accept(t *testing.T) *Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	session, err := h.listener.Accept(ctx)
	if err != nil {
		t.Fatalf("accept session: %v", err)
	}
	return session.(*Session)
}

func (h *harness) expectNoSession(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if session, err := h.listener.Accept(ctx); err == nil {
		t.Fatalf("unexpected session from %s", session.PeerKey())
	}
}

// expectDropped waits until the desktop ends the connection.
func expectDropped(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(testTimeout))
	_, err := conn.Read(make([]byte, 1))
	var netErr net.Error
	if err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("connection stayed open: %v", err)
	}
}

func waitDone(t *testing.T, session transport.Session) {
	t.Helper()
	select {
	case <-session.Done():
	case <-time.After(testTimeout):
		t.Fatal("session did not close")
	}
}

func acceptStream(t *testing.T, session transport.Session) transport.Stream {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	stream, err := session.AcceptStream(ctx)
	if err != nil {
		t.Fatalf("accept stream: %v", err)
	}
	return stream
}

func TestRegisteredPhoneGetsATorSessionWithOneStream(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)

	client := h.dial(t, phone)
	session := h.accept(t)
	if session.Transport() != transport.NameTor || !session.Registered() || session.PeerKey() != phone.PublicKeyString() || session.DeviceID() != phone.ID() {
		t.Fatalf("unexpected session: %s registered=%v key=%s device=%s", session.Transport(), session.Registered(), session.PeerKey(), session.DeviceID())
	}

	stream := acceptStream(t, session)
	if stream.Session() != session {
		t.Fatal("stream is not bound to its session")
	}
	go func() {
		_, _ = io.Copy(stream, stream)
		_ = stream.Close()
	}()
	_ = client.SetDeadline(time.Now().Add(testTimeout))
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	echoed := make([]byte, 4)
	if _, err := io.ReadFull(client, echoed); err != nil || string(echoed) != "ping" {
		t.Fatalf("echo failed: %q %v", echoed, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := session.AcceptStream(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a second stream was handed out: %v", err)
	}
	if _, err := session.OpenStream(context.Background()); !errors.Is(err, transport.ErrStreamRefused) {
		t.Fatalf("desktop opened a stream over the onion: %v", err)
	}

	_ = client.Close()
	waitDone(t, session)
	if _, err := session.AcceptStream(context.Background()); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("closed session accepted a stream: %v", err)
	}
}

func TestUnregisteredPhoneNeedsActivePairingAndIsPromoted(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)

	refused := h.dial(t, phone)
	expectDropped(t, refused)
	h.expectNoSession(t)

	h.gate.active.Store(true)
	h.dial(t, phone)
	session := h.accept(t)
	if session.Registered() || h.listener.RestrictedSessions() != 1 {
		t.Fatalf("restricted session registered=%v restricted=%d", session.Registered(), h.listener.RestrictedSessions())
	}
	if promoted := h.listener.Promote(phone.PublicKeyString()); promoted != 0 {
		t.Fatal("promoted a key the registry does not know")
	}
	h.registry.register(phone)
	if promoted := h.listener.Promote(phone.PublicKeyString()); promoted != 1 {
		t.Fatalf("promoted %d sessions, want 1", promoted)
	}
	if !session.Registered() || session.DeviceID() != phone.ID() || h.listener.RestrictedSessions() != 0 {
		t.Fatal("promotion did not register the session and release its slot")
	}
	// Promotion stops the restricted timers: the session survives the gate.
	h.gate.active.Store(false)
	select {
	case <-session.Done():
		t.Fatal("a promoted session was closed by the pairing gate")
	case <-time.After(2500 * time.Millisecond):
	}
}

func TestRestrictedEntryIsLimitedToFourSessions(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	h.gate.active.Store(true)
	for range transport.MaxRestrictedSessions {
		h.dial(t, mustIdentity(t, identity.RolePhone))
		h.accept(t)
	}
	extra := h.dial(t, mustIdentity(t, identity.RolePhone))
	expectDropped(t, extra)
	h.expectNoSession(t)
	if h.listener.RestrictedSessions() != transport.MaxRestrictedSessions {
		t.Fatalf("restricted sessions: %d", h.listener.RestrictedSessions())
	}

	// A registered phone is not counted against the restricted entry.
	registered := mustIdentity(t, identity.RolePhone)
	h.registry.register(registered)
	h.dial(t, registered)
	if session := h.accept(t); !session.Registered() {
		t.Fatal("registered phone was limited by the restricted entry")
	}
}

func TestRestrictedSessionEndsAtLifetimeOrWhenPairingStops(t *testing.T) {
	h := newHarness(t, ListenConfig{RestrictedLifetime: 300 * time.Millisecond, GateInterval: 50 * time.Millisecond})
	h.gate.active.Store(true)
	expiring := h.dial(t, mustIdentity(t, identity.RolePhone))
	session := h.accept(t)
	waitDone(t, session)
	if !errors.Is(session.Err(), transport.ErrRestrictedExpired) {
		t.Fatalf("session ended with %v, want expired", session.Err())
	}
	expectDropped(t, expiring)
	if h.listener.RestrictedSessions() != 0 {
		t.Fatal("expired session kept its restricted slot")
	}

	h = newHarness(t, ListenConfig{GateInterval: 50 * time.Millisecond})
	h.gate.active.Store(true)
	h.dial(t, mustIdentity(t, identity.RolePhone))
	session = h.accept(t)
	h.gate.active.Store(false)
	waitDone(t, session)
	if !errors.Is(session.Err(), transport.ErrPairingInactive) {
		t.Fatalf("session ended with %v, want pairing inactive", session.Err())
	}
}

func TestCloseKeyClosesEverySessionOfTheKey(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone, other := mustIdentity(t, identity.RolePhone), mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	h.registry.register(other)
	clients := []*tls.Conn{h.dial(t, phone), h.dial(t, phone)}
	sessions := []*Session{h.accept(t), h.accept(t)}
	h.dial(t, other)
	survivor := h.accept(t)

	started := time.Now()
	if closed := h.listener.CloseKey(phone.PublicKeyString()); closed != 2 {
		t.Fatalf("closed %d sessions, want 2", closed)
	}
	for index, session := range sessions {
		if session.PeerKey() != phone.PublicKeyString() {
			t.Fatal("sessions were accepted out of order")
		}
		waitDone(t, session)
		if !errors.Is(session.Err(), transport.ErrRevoked) {
			t.Fatalf("session ended with %v, want revoked", session.Err())
		}
		expectDropped(t, clients[index])
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("revocation took %s", elapsed)
	}
	select {
	case <-survivor.Done():
		t.Fatal("CloseKey closed another key")
	default:
	}
	if closed := h.listener.CloseKey(phone.PublicKeyString()); closed != 0 {
		t.Fatal("CloseKey counted closed sessions twice")
	}
}

// Once the registry drops a key, a session of the key still waiting for its
// stream is closed instead of served, the stream already handed out keeps
// delivering, as the 4401 close of the bridge needs, CloseKey ends it on the
// phone in under one second and a new onion connection of the key is refused
// outside pairing.
func TestRevokedKeyIsRefusedBeforeItsStreamAndOnReconnect(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	active := h.dial(t, phone)
	activeSession := h.accept(t)
	stream := acceptStream(t, activeSession)
	go func() { _, _ = io.Copy(stream, stream) }()
	waiting := h.dial(t, phone)
	waitingSession := h.accept(t)
	expectEchoed := func(message string) {
		t.Helper()
		_ = active.SetDeadline(time.Now().Add(testTimeout))
		if _, err := active.Write([]byte(message)); err != nil {
			t.Fatal(err)
		}
		echoed := make([]byte, len(message))
		if _, err := io.ReadFull(active, echoed); err != nil || string(echoed) != message {
			t.Fatalf("handed stream echoed %q: %v", echoed, err)
		}
	}
	expectEchoed("before")

	h.registry.revoke(phone)
	if _, err := waitingSession.AcceptStream(context.Background()); !errors.Is(err, transport.ErrRevoked) {
		t.Fatalf("a revoked key got its stream: %v", err)
	}
	expectDropped(t, waiting)
	expectEchoed("in flight")

	started := time.Now()
	if closed := h.listener.CloseKey(phone.PublicKeyString()); closed != 1 {
		t.Fatalf("closed %d sessions, want the one still serving", closed)
	}
	expectDropped(t, active)
	elapsed := time.Since(started)
	t.Logf("phone saw the onion connection close %s after CloseKey", elapsed)
	if elapsed >= time.Second || !errors.Is(activeSession.Err(), transport.ErrRevoked) {
		t.Fatalf("session closed after %s with %v", elapsed, activeSession.Err())
	}

	expectDropped(t, h.dial(t, phone))
	h.expectNoSession(t)

	// During a pairing the revoked key only gets the restricted entry, so the
	// same phone can pair again.
	h.gate.active.Store(true)
	h.dial(t, phone)
	if session := h.accept(t); session.Registered() {
		t.Fatal("revoked key was admitted as registered")
	}
}

func TestInvalidPeersAndStalledHandshakesAreRefused(t *testing.T) {
	h := newHarness(t, ListenConfig{HandshakeTimeout: 200 * time.Millisecond})
	h.gate.active.Store(true)

	anonymous := &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, NextProtos: []string{identity.ALPN}}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if conn, err := (&tls.Dialer{Config: anonymous}).DialContext(ctx, "tcp", h.listener.Addr().String()); err == nil {
		expectDropped(t, conn)
		_ = conn.Close()
	}
	h.expectNoSession(t)

	stalled, err := net.Dial("tcp", h.listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	expectDropped(t, stalled)
	h.expectNoSession(t)
}

func TestCloseEndsAcceptAndSessions(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	h.dial(t, phone)
	session := h.accept(t)
	if err := h.listener.Close(); err != nil {
		t.Fatal(err)
	}
	waitDone(t, session)
	if _, err := h.listener.Accept(context.Background()); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("Accept after Close: %v", err)
	}

	// Tor closing its listener first, as tor.Desktop.Close does, also ends
	// Accept.
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := Listen(raw, h.desktop, ListenConfig{})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_ = raw.Close()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if _, err := listener.Accept(ctx); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("Accept after the raw listener closed: %v", err)
	}
}
