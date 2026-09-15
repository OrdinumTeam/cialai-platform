// SPDX-License-Identifier: Apache-2.0
package onion

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// dialControl opens a control connection, which negotiates the control ALPN.
func (h *harness) dialControl(t *testing.T, phone *identity.Identity) *tls.Conn {
	t.Helper()
	config, err := identity.ControlClientConfig(phone, h.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", h.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial control connection: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn.(*tls.Conn)
}

func (h *harness) acceptControl(t *testing.T) *Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	session, err := h.listener.AcceptControl(ctx)
	if err != nil {
		t.Fatalf("accept control session: %v", err)
	}
	return session.(*Session)
}

func (h *harness) expectNoControl(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if session, err := h.listener.AcceptControl(ctx); err == nil {
		t.Fatalf("unexpected control session from %s", session.PeerKey())
	}
}

func echoOnce(t *testing.T, client *tls.Conn, message string) {
	t.Helper()
	_ = client.SetDeadline(time.Now().Add(testTimeout))
	if _, err := client.Write([]byte(message)); err != nil {
		t.Fatal(err)
	}
	echoed := make([]byte, len(message))
	if _, err := io.ReadFull(client, echoed); err != nil || string(echoed) != message {
		t.Fatalf("echo = %q, %v", echoed, err)
	}
}

func TestControlConnectionsAreKeptApartFromTheEdge(t *testing.T) {
	h := newHarness(t, ListenConfig{Control: true})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)

	controlClient := h.dialControl(t, phone)
	edgeClient := h.dial(t, phone)
	if protocol := controlClient.ConnectionState().NegotiatedProtocol; protocol != identity.ControlALPN {
		t.Fatalf("control connection negotiated %q", protocol)
	}
	if protocol := edgeClient.ConnectionState().NegotiatedProtocol; protocol != identity.ALPN {
		t.Fatalf("edge connection negotiated %q", protocol)
	}
	control := h.acceptControl(t)
	edge := h.accept(t)
	h.expectNoSession(t)
	if !control.Control() || edge.Control() {
		t.Fatalf("control flags: control=%v edge=%v", control.Control(), edge.Control())
	}
	if control.Transport() != transport.NameTor || !control.Registered() || control.PeerKey() != phone.PublicKeyString() || control.DeviceID() != phone.ID() {
		t.Fatalf("control session over %s registered=%v key=%s device=%s", control.Transport(), control.Registered(), control.PeerKey(), control.DeviceID())
	}

	if _, err := control.AcceptStream(context.Background()); !errors.Is(err, transport.ErrStreamRefused) {
		t.Fatalf("control session handed an edge stream: %v", err)
	}
	if _, err := edge.AcceptControl(context.Background()); !errors.Is(err, transport.ErrStreamRefused) {
		t.Fatalf("edge session handed a control stream: %v", err)
	}
	if _, err := control.OpenControl(context.Background()); !errors.Is(err, transport.ErrStreamRefused) {
		t.Fatalf("desktop opened a control stream: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	stream, err := control.AcceptControl(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stream.Session() != control {
		t.Fatal("control stream is not bound to its session")
	}
	go func() {
		_, _ = io.Copy(stream, stream)
		_ = stream.Close()
	}()
	echoOnce(t, controlClient, "hello")

	short, cancelShort := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelShort()
	if _, err := control.AcceptControl(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a second control stream was handed out: %v", err)
	}
	_ = controlClient.Close()
	waitDone(t, control)
	select {
	case <-edge.Done():
		t.Fatal("closing the control connection ended the edge session")
	default:
	}
}

// The restricted pairing entry never carries a control connection, and a
// revoked key opens none: the handshake is refused, a session waiting for its
// stream is closed and CloseKey ends the one in use.
func TestControlIsRefusedToUnknownPairingAndRevokedKeys(t *testing.T) {
	h := newHarness(t, ListenConfig{Control: true})
	unknown := mustIdentity(t, identity.RolePhone)
	expectDropped(t, h.dialControl(t, unknown))
	h.expectNoControl(t)

	h.gate.active.Store(true)
	expectDropped(t, h.dialControl(t, unknown))
	h.expectNoControl(t)
	h.dial(t, unknown)
	if restricted := h.accept(t); restricted.Registered() {
		t.Fatal("pairing phone was registered")
	}
	h.gate.active.Store(false)

	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	inUse := h.dialControl(t, phone)
	inUseSession := h.acceptControl(t)
	stream, err := inUseSession.AcceptControl(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = io.Copy(stream, stream) }()
	echoOnce(t, inUse, "before")
	waiting := h.dialControl(t, phone)
	waitingSession := h.acceptControl(t)

	h.registry.revoke(phone)
	if _, err := waitingSession.AcceptControl(context.Background()); !errors.Is(err, transport.ErrRevoked) {
		t.Fatalf("a revoked key got its control stream: %v", err)
	}
	expectDropped(t, waiting)
	if closed := h.listener.CloseKey(phone.PublicKeyString()); closed != 1 {
		t.Fatalf("CloseKey closed %d sessions, want the control session in use", closed)
	}
	expectDropped(t, inUse)
	if !errors.Is(inUseSession.Err(), transport.ErrRevoked) {
		t.Fatalf("control session ended with %v", inUseSession.Err())
	}

	expectDropped(t, h.dialControl(t, phone))
	h.expectNoControl(t)
	h.gate.active.Store(true)
	expectDropped(t, h.dialControl(t, phone))
	h.expectNoControl(t)
}

func TestControlNeedsTheListenerOption(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	config, err := identity.ControlClientConfig(phone, h.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", h.listener.Addr().String()); err == nil {
		_ = conn.Close()
		t.Fatal("a listener without control connections completed a control handshake")
	}
	h.expectNoSession(t)
	if _, err := h.listener.AcceptControl(ctx); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("AcceptControl without the option: %v", err)
	}
}

func TestControlConnectionsOfAKeyKeepTheNewest(t *testing.T) {
	h := newHarness(t, ListenConfig{Control: true})
	phone, other := mustIdentity(t, identity.RolePhone), mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	h.registry.register(other)
	h.dialControl(t, other)
	otherSession := h.acceptControl(t)
	var sessions []*Session
	for range MaxControlPerKey + 1 {
		h.dialControl(t, phone)
		sessions = append(sessions, h.acceptControl(t))
	}
	waitDone(t, sessions[0])
	if !errors.Is(sessions[0].Err(), errControlReplaced) {
		t.Fatalf("oldest control session ended with %v", sessions[0].Err())
	}
	for _, session := range append(sessions[1:], otherSession) {
		select {
		case <-session.Done():
			t.Fatalf("a newer control session ended: %v", session.Err())
		default:
		}
	}
	if err := h.listener.Close(); err != nil {
		t.Fatal(err)
	}
	for _, session := range sessions[1:] {
		waitDone(t, session)
	}
	if _, err := h.listener.AcceptControl(context.Background()); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("AcceptControl after Close: %v", err)
	}
}
