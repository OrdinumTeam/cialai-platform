// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"bytes"
	"context"
	"crypto/rand"
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

func newFakeRegistry() *fakeRegistry { return &fakeRegistry{keys: make(map[string]string)} }

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

type harness struct {
	desktop  *identity.Identity
	server   *Endpoint
	listener *Listener
	registry *fakeRegistry
	gate     *fakeGate
}

func newHarness(t testing.TB, config ListenConfig) *harness {
	t.Helper()
	desktop := mustIdentity(t, identity.RoleDesktop)
	h := &harness{desktop: desktop, registry: newFakeRegistry(), gate: &fakeGate{}}
	h.server = newTestEndpoint(t, desktop)
	config.Registry = h.registry
	config.Pairing = h.gate
	listener, err := h.server.Listen(config)
	if err != nil {
		t.Fatal(err)
	}
	h.listener = listener
	return h
}

func mustIdentity(t testing.TB, role identity.Role) *identity.Identity {
	t.Helper()
	local, err := identity.Generate(role, nil)
	if err != nil {
		t.Fatal(err)
	}
	return local
}

func newTestEndpoint(t testing.TB, local *identity.Identity) *Endpoint {
	t.Helper()
	endpoint, err := New(Config{PacketConn: listenUDP(t), Identity: local})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	return endpoint
}

func listenUDP(t testing.TB) net.PacketConn {
	t.Helper()
	packetConn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return packetConn
}

// dial opens a session from a new phone endpoint to the harness listener.
func (h *harness) dial(t testing.TB, phone *identity.Identity) (*Session, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	session, err := newTestEndpoint(t, phone).Dial(ctx, h.listener.Addr().String(), h.desktop.PublicKey())
	if err != nil {
		return nil, err
	}
	return session.(*Session), nil
}

func (h *harness) mustDial(t testing.TB, phone *identity.Identity) *Session {
	t.Helper()
	session, err := h.dial(t, phone)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func (h *harness) accept(t testing.TB) *Session {
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

// serveEcho echoes every data stream the session accepts and counts them.
func serveEcho(session transport.Session) *atomic.Int32 {
	accepted := &atomic.Int32{}
	go func() {
		for {
			conn, err := session.AcceptStream(context.Background())
			if err != nil {
				return
			}
			accepted.Add(1)
			go echoConn(conn)
		}
	}()
	return accepted
}

func echoConn(conn net.Conn) {
	defer conn.Close()
	_, _ = io.Copy(conn, conn)
	_ = conn.(interface{ CloseWrite() error }).CloseWrite()
}

func openStream(t testing.TB, session transport.Session) transport.Stream {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	conn, err := session.OpenStream(ctx)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	return conn
}

// echoPayload writes size random bytes, half-closes and expects them back.
func echoPayload(conn net.Conn, size int) error {
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	_ = conn.SetDeadline(time.Now().Add(testTimeout))
	written := make(chan error, 1)
	go func() {
		_, err := conn.Write(payload)
		if err == nil {
			err = conn.(interface{ CloseWrite() error }).CloseWrite()
		}
		written <- err
	}()
	received, readErr := io.ReadAll(conn)
	if err := errors.Join(<-written, readErr); err != nil {
		return err
	}
	if !bytes.Equal(received, payload) {
		return errors.New("echoed payload differs")
	}
	return nil
}

// expectRefused reads from a stream the peer must reset.
func expectRefused(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(testTimeout))
	_, err := conn.Read(make([]byte, 1))
	if !errors.Is(err, transport.ErrStreamRefused) {
		t.Fatalf("stream was not refused: %v", err)
	}
}

func waitDone(t testing.TB, session transport.Session) {
	t.Helper()
	select {
	case <-session.Done():
	case <-time.After(testTimeout):
		t.Fatal("session did not close")
	}
}

func eventually(t testing.TB, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
