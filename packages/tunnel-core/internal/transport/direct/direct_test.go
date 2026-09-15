// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

const mebibyte = 1 << 20

func TestRegisteredSessionEchoesOneMiBPerStream(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)

	client := h.mustDial(t, phone)
	server := h.accept(t)
	if server.PeerKey() != phone.PublicKeyString() || client.PeerKey() != h.desktop.PublicKeyString() {
		t.Fatalf("peer keys differ: server sees %s, client sees %s", server.PeerKey(), client.PeerKey())
	}
	if !server.Registered() || server.DeviceID() != phone.ID() || server.Transport() != transport.NameDirect || !client.Registered() {
		t.Fatalf("unexpected session state registered=%v device=%q transport=%q", server.Registered(), server.DeviceID(), server.Transport())
	}
	serveEcho(server)
	serveEcho(client)

	var wait sync.WaitGroup
	failures := make(chan error, 4)
	for range 3 {
		wait.Go(func() {
			conn := openStream(t, client)
			defer conn.Close()
			if conn.Session() != transport.Session(client) {
				failures <- errors.New("stream is not bound to its session")
			}
			failures <- echoPayload(conn, mebibyte)
		})
	}
	wait.Go(func() {
		conn := openStream(t, server)
		defer conn.Close()
		failures <- echoPayload(conn, mebibyte)
	})
	wait.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}

	control, err := client.OpenControl(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.OpenControl(context.Background()); err == nil {
		t.Fatal("a second control stream was opened")
	}
	if _, err := server.OpenControl(context.Background()); err == nil {
		t.Fatal("the accepting side opened a control stream")
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	accepted, err := server.AcceptControl(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	message := make([]byte, 4)
	if _, err := io.ReadFull(accepted, message); err != nil || string(message) != "ping" {
		t.Fatalf("control message %q: %v", message, err)
	}

	if err := h.listener.Close(); err != nil {
		t.Fatal(err)
	}
	waitDone(t, client)
	if !errors.Is(client.Err(), transport.ErrClosed) {
		t.Fatalf("client close reason: %v", client.Err())
	}
}

func TestSessionWithoutCertificateIsRefused(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	h.gate.active.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	config := &tls.Config{
		MinVersion:         tls.VersionTLS13,
		NextProtos:         []string{identity.ALPN},
		ServerName:         identity.ServerName,
		InsecureSkipVerify: true, // The test only checks that the server refuses.
	}
	remote := h.listener.Addr().(*net.UDPAddr)
	conn, err := quic.Dial(ctx, listenUDP(t), remote, config, &quic.Config{HandshakeIdleTimeout: 2 * time.Second})
	if err == nil {
		select {
		case <-conn.Context().Done():
		case <-time.After(testTimeout):
			t.Fatal("server kept a session without client certificate")
		}
	}
	h.expectNoSession(t)
}

func TestUnknownKeyIsRefusedWithoutActivePairing(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	client, err := h.dial(t, phone)
	if err == nil {
		waitDone(t, client)
		err = client.Err()
	}
	if !errors.Is(err, transport.ErrPairingInactive) {
		t.Fatalf("unknown key was not refused for inactive pairing: %v", err)
	}
	h.expectNoSession(t)
	if h.listener.RestrictedSessions() != 0 {
		t.Fatal("refused session still counted")
	}
}

func TestRestrictedSessionReachesOnlyThePairingStream(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	h.gate.active.Store(true)
	phone := mustIdentity(t, identity.RolePhone)
	client := h.mustDial(t, phone)
	server := h.accept(t)
	if server.Registered() || h.listener.RestrictedSessions() != 1 {
		t.Fatalf("session should be restricted: registered=%v restricted=%d", server.Registered(), h.listener.RestrictedSessions())
	}
	accepted := serveEcho(server)

	control, err := client.OpenControl(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	expectRefused(t, control)

	pairing := openStream(t, client)
	if err := echoPayload(pairing, mebibyte); err != nil {
		t.Fatalf("pairing stream: %v", err)
	}
	expectRefused(t, openStream(t, client))
	if _, err := server.OpenStream(context.Background()); !errors.Is(err, transport.ErrStreamRefused) {
		t.Fatalf("server opened a stream to a restricted peer: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := server.AcceptControl(ctx); err == nil {
		t.Fatal("restricted session delivered a control stream")
	}
	if accepted.Load() != 1 {
		t.Fatalf("restricted session delivered %d data streams", accepted.Load())
	}
	if client.Err() != nil {
		t.Fatalf("refused streams closed the session: %v", client.Err())
	}
}

func TestRestrictedSessionExpires(t *testing.T) {
	if transport.RestrictedLifetime != 60*time.Second || transport.MaxRestrictedSessions != 4 {
		t.Fatal("restricted entry limits changed")
	}
	defaults := newHarness(t, ListenConfig{})
	if defaults.listener.restrictedLifetime != transport.RestrictedLifetime || defaults.listener.maxRestricted != transport.MaxRestrictedSessions {
		t.Fatal("listener does not default to the restricted entry limits")
	}

	h := newHarness(t, ListenConfig{RestrictedLifetime: 300 * time.Millisecond, GateInterval: 50 * time.Millisecond})
	h.gate.active.Store(true)
	client := h.mustDial(t, mustIdentity(t, identity.RolePhone))
	server := h.accept(t)
	started := time.Now()
	waitDone(t, client)
	if elapsed := time.Since(started); elapsed < 200*time.Millisecond {
		t.Fatalf("restricted session closed too early: %s", elapsed)
	}
	if !errors.Is(client.Err(), transport.ErrRestrictedExpired) || !errors.Is(server.Err(), transport.ErrRestrictedExpired) {
		t.Fatalf("close reasons: client %v, server %v", client.Err(), server.Err())
	}
	eventually(t, func() bool { return h.listener.RestrictedSessions() == 0 })
}

func TestRestrictedSessionClosesWhenPairingEnds(t *testing.T) {
	h := newHarness(t, ListenConfig{GateInterval: 50 * time.Millisecond})
	h.gate.active.Store(true)
	client := h.mustDial(t, mustIdentity(t, identity.RolePhone))
	h.accept(t)
	h.gate.active.Store(false)
	waitDone(t, client)
	if !errors.Is(client.Err(), transport.ErrPairingInactive) {
		t.Fatalf("close reason: %v", client.Err())
	}
}

func TestRestrictedSessionsAreLimitedToFour(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	h.gate.active.Store(true)
	var servers []*Session
	for range transport.MaxRestrictedSessions {
		h.mustDial(t, mustIdentity(t, identity.RolePhone))
		servers = append(servers, h.accept(t))
	}
	extra, err := h.dial(t, mustIdentity(t, identity.RolePhone))
	if err == nil {
		waitDone(t, extra)
		err = extra.Err()
	}
	if !errors.Is(err, transport.ErrRestrictedLimit) {
		t.Fatalf("fifth restricted session was not refused: %v", err)
	}
	h.expectNoSession(t)

	_ = servers[0].Close()
	eventually(t, func() bool { return h.listener.RestrictedSessions() == transport.MaxRestrictedSessions-1 })
	h.mustDial(t, mustIdentity(t, identity.RolePhone))
	h.accept(t)
}

func TestSessionIsPromotedAfterRegistration(t *testing.T) {
	h := newHarness(t, ListenConfig{RestrictedLifetime: 400 * time.Millisecond, GateInterval: 50 * time.Millisecond})
	h.gate.active.Store(true)
	phone := mustIdentity(t, identity.RolePhone)
	client := h.mustDial(t, phone)
	server := h.accept(t)
	serveEcho(server)
	if err := echoPayload(openStream(t, client), 1024); err != nil {
		t.Fatal(err)
	}

	if h.listener.Promote(phone.PublicKeyString()) != 0 {
		t.Fatal("promoted a key the registry does not know")
	}
	h.registry.register(phone)
	h.gate.active.Store(false) // The pairing session was consumed.
	if promoted := h.listener.Promote(phone.PublicKeyString()); promoted != 1 {
		t.Fatalf("promoted %d sessions", promoted)
	}
	if !server.Registered() || server.DeviceID() != phone.ID() || h.listener.RestrictedSessions() != 0 {
		t.Fatalf("promotion incomplete: registered=%v device=%q restricted=%d", server.Registered(), server.DeviceID(), h.listener.RestrictedSessions())
	}
	time.Sleep(600 * time.Millisecond) // Past the restricted lifetime.
	if client.Err() != nil {
		t.Fatalf("promoted session closed: %v", client.Err())
	}
	for range 2 {
		if err := echoPayload(openStream(t, client), 1024); err != nil {
			t.Fatalf("stream after promotion: %v", err)
		}
	}
	control, err := client.OpenControl(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if _, err := server.AcceptControl(ctx); err != nil {
		t.Fatalf("control stream after promotion: %v", err)
	}
}

func TestRestrictedSessionIsPromotedOnItsNextStream(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	h.gate.active.Store(true)
	phone := mustIdentity(t, identity.RolePhone)
	client := h.mustDial(t, phone)
	server := h.accept(t)
	serveEcho(server)
	if err := echoPayload(openStream(t, client), 64); err != nil {
		t.Fatal(err)
	}
	h.registry.register(phone)
	if err := echoPayload(openStream(t, client), 64); err != nil {
		t.Fatalf("stream after registration: %v", err)
	}
	if !server.Registered() {
		t.Fatal("session was not promoted by the registry")
	}
}

func TestCloseKeyClosesRevokedSessions(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	revoked := mustIdentity(t, identity.RolePhone)
	kept := mustIdentity(t, identity.RolePhone)
	h.registry.register(revoked)
	h.registry.register(kept)
	first := h.mustDial(t, revoked)
	h.accept(t)
	second := h.mustDial(t, revoked)
	h.accept(t)
	other := h.mustDial(t, kept)
	serveEcho(h.accept(t))

	h.registry.revoke(revoked)
	if closed := h.listener.CloseKey(revoked.PublicKeyString()); closed != 2 {
		t.Fatalf("closed %d sessions", closed)
	}
	for _, session := range []*Session{first, second} {
		waitDone(t, session)
		if !errors.Is(session.Err(), transport.ErrRevoked) {
			t.Fatalf("close reason: %v", session.Err())
		}
	}
	if err := echoPayload(openStream(t, other), 1024); err != nil {
		t.Fatalf("unrelated session broken by revocation: %v", err)
	}
	if h.listener.CloseKey(revoked.PublicKeyString()) != 0 {
		t.Fatal("revoked sessions are still tracked")
	}

	again, err := h.dial(t, revoked)
	if err == nil {
		waitDone(t, again)
		err = again.Err()
	}
	if !errors.Is(err, transport.ErrRevoked) {
		t.Fatalf("revoked key reconnected: %v", err)
	}
}

// Once the registry drops a key, the live session of the key refuses new
// streams while its open stream keeps delivering, as the 4401 close of the
// bridge needs; CloseKey then ends the session on the phone in under one
// second and a new handshake is refused as revoked outside pairing.
func TestRevokedKeyIsRefusedOnNewStreamsAndHandshakes(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	client := h.mustDial(t, phone)
	server := h.accept(t)
	accepted := serveEcho(server)
	open := openStream(t, client)
	expectEchoed := func(message string) {
		t.Helper()
		_ = open.SetDeadline(time.Now().Add(testTimeout))
		if _, err := open.Write([]byte(message)); err != nil {
			t.Fatal(err)
		}
		echoed := make([]byte, len(message))
		if _, err := io.ReadFull(open, echoed); err != nil || string(echoed) != message {
			t.Fatalf("open stream echoed %q: %v", echoed, err)
		}
	}
	expectEchoed("before")

	h.registry.revoke(phone)
	expectRefused(t, openStream(t, client))
	control, err := client.OpenControl(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	expectRefused(t, control)
	expectEchoed("in flight")
	if accepted.Load() != 1 || client.Err() != nil {
		t.Fatalf("revoked key reached %d streams or lost its session early: %v", accepted.Load(), client.Err())
	}

	started := time.Now()
	if closed := h.listener.CloseKey(phone.PublicKeyString()); closed != 1 {
		t.Fatalf("closed %d sessions", closed)
	}
	waitDone(t, client)
	elapsed := time.Since(started)
	t.Logf("phone saw the QUIC session close %s after CloseKey", elapsed)
	if elapsed >= time.Second || !errors.Is(client.Err(), transport.ErrRevoked) {
		t.Fatalf("session closed after %s with %v", elapsed, client.Err())
	}
	if _, err := open.Read(make([]byte, 1)); !errors.Is(err, transport.ErrRevoked) {
		t.Fatalf("open stream survived the revocation: %v", err)
	}

	again, err := h.dial(t, phone)
	if err == nil {
		waitDone(t, again)
		err = again.Err()
	}
	if !errors.Is(err, transport.ErrRevoked) {
		t.Fatalf("revoked key was not refused as revoked: %v", err)
	}
	h.expectNoSession(t)

	// During a pairing the revoked key only gets the restricted entry, so the
	// same phone can pair again.
	h.gate.active.Store(true)
	h.mustDial(t, phone)
	if session := h.accept(t); session.Registered() {
		t.Fatal("revoked key was admitted as registered")
	}
}

func TestClientMigratesToANewSocket(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	client := h.mustDial(t, phone)
	server := h.accept(t)
	serveEcho(server)
	if err := echoPayload(openStream(t, client), 1024); err != nil {
		t.Fatal(err)
	}
	oldRemote := server.RemoteAddr().String()

	moved := listenUDP(t)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := client.Migrate(ctx, moved); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if client.LocalAddr().String() != moved.LocalAddr().String() {
		t.Fatalf("client still uses %s", client.LocalAddr())
	}
	if err := echoPayload(openStream(t, client), mebibyte); err != nil {
		t.Fatalf("echo after migration: %v", err)
	}
	eventually(t, func() bool { return server.RemoteAddr().String() == moved.LocalAddr().String() })
	if oldRemote == moved.LocalAddr().String() {
		t.Fatal("migration did not change the path")
	}
	if err := server.Migrate(ctx, listenUDP(t)); err == nil {
		t.Fatal("accepting side migrated")
	}
}

func TestEndpointCloseEndsDialedSessions(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	endpoint := newTestEndpoint(t, phone)
	session, err := endpoint.Dial(ctx, h.listener.Addr().String(), h.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	server := h.accept(t)
	if err := endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	waitDone(t, server)
	if _, err := endpoint.Dial(ctx, h.listener.Addr().String(), h.desktop.PublicKey()); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("closed endpoint dialed: %v", err)
	}
	if _, err := session.OpenStream(ctx); err == nil {
		t.Fatal("closed session opened a stream")
	}
}

func TestEndpointTimingsAndSingleListener(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	config := h.server.quicConfig
	if config.KeepAlivePeriod != 5*time.Second || config.MaxIdleTimeout != 15*time.Second {
		t.Fatalf("keepalive %s and idle %s differ from 5 s and 15 s", config.KeepAlivePeriod, config.MaxIdleTimeout)
	}
	if config.MaxIncomingUniStreams >= 0 || config.Allow0RTT {
		t.Fatal("unidirectional streams or 0-RTT are allowed")
	}
	if _, err := h.server.Listen(ListenConfig{}); err == nil {
		t.Fatal("a second listener started on the same endpoint")
	}
	if err := h.listener.Close(); err != nil {
		t.Fatal(err)
	}
	relisten, err := h.server.Listen(ListenConfig{Registry: h.registry})
	if err != nil {
		t.Fatalf("listen after close: %v", err)
	}
	h.listener = relisten
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	client := h.mustDial(t, phone)
	serveEcho(h.accept(t))
	if err := echoPayload(openStream(t, client), 1024); err != nil {
		t.Fatalf("echo through the new listener: %v", err)
	}
}

func TestDialRejectsWrongDesktopKey(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	impostor := mustIdentity(t, identity.RoleDesktop)
	if _, err := newTestEndpoint(t, phone).Dial(ctx, h.listener.Addr().String(), impostor.PublicKey()); err == nil {
		t.Fatal("dial accepted a desktop key that differs from the pin")
	}
	h.expectNoSession(t)
}
