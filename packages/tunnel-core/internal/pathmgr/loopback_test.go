// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/onion"
)

// These tests use the wall clock and the real carriers over loopback: the
// QUIC endpoint of the direct transport and the mutual TLS of the onion
// listener, with a TCP dial standing in for the Tor SOCKS hop.

var (
	_ DirectDialer = (*direct.Endpoint)(nil)
	_ Migrator     = (*direct.Session)(nil)
)

const loopbackTimeout = 10 * time.Second

type staticRegistry map[string]string

func (registry staticRegistry) RegisteredKey(key string) (string, bool) {
	id, ok := registry[key]
	return id, ok
}

// loopbackDesktop runs the direct and onion listeners of a desktop and
// answers every edge stream with the name of the transport that carried it.
type loopbackDesktop struct {
	identity *identity.Identity
	endpoint *direct.Endpoint
	onionTCP net.Listener
}

func startLoopbackDesktop(t *testing.T, phone *identity.Identity) *loopbackDesktop {
	t.Helper()
	desktop := &loopbackDesktop{identity: mustIdentity(t, identity.RoleDesktop)}
	registry := staticRegistry{phone.PublicKeyString(): phone.ID()}
	desktop.endpoint = newLoopbackEndpoint(t, desktop.identity)
	directListener, err := desktop.endpoint.Listen(direct.ListenConfig{Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	desktop.onionTCP, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	onionListener, err := onion.Listen(desktop.onionTCP, desktop.identity, onion.ListenConfig{Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	listeners := transport.NewMultiListener(directListener, onionListener)
	t.Cleanup(func() { _ = listeners.Close() })
	go serveTransportNames(listeners)
	return desktop
}

func serveTransportNames(listener transport.Listener) {
	ctx := context.Background()
	for {
		session, err := listener.Accept(ctx)
		if err != nil {
			return
		}
		go func() {
			defer session.Close()
			for {
				stream, err := session.AcceptStream(ctx)
				if err != nil {
					return
				}
				go func() {
					defer stream.Close()
					_, _ = io.WriteString(stream, session.Transport()+"\n")
					_, _ = io.Copy(io.Discard, stream)
				}()
			}
		}()
	}
}

func newLoopbackEndpoint(t *testing.T, local *identity.Identity) *direct.Endpoint {
	t.Helper()
	packetConn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: packetConn, Identity: local})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	return endpoint
}

// loopbackTor reaches the onion listener with a plain TCP dial and the same
// pinned mutual TLS tor.Client uses.
type loopbackTor struct {
	address string
	dials   atomic.Int32
}

func (fake *loopbackTor) Bootstrap(context.Context) (tor.Bootstrap, error) {
	return tor.Bootstrap{Progress: 100, Tag: "done"}, nil
}

func (fake *loopbackTor) DialTLS(ctx context.Context, _ string, local *identity.Identity, pinned ed25519.PublicKey) (*tls.Conn, error) {
	fake.dials.Add(1)
	config, err := identity.ClientConfig(local, pinned)
	if err != nil {
		return nil, err
	}
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", fake.address)
	if err != nil {
		return nil, err
	}
	conn := tls.Client(raw, config)
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}

func loopbackContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), loopbackTimeout)
	t.Cleanup(cancel)
	return ctx
}

// carrier opens one edge stream through the manager and returns the
// transport name the desktop saw, with the local address of the stream.
func carrier(t *testing.T, ctx context.Context, manager *Manager) (string, net.Addr) {
	t.Helper()
	conn, err := manager.DialContext(ctx, "tcp", "cialai-desktop:47400")
	if err != nil {
		t.Fatalf("dial through the manager: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(loopbackTimeout))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read transport name: %v", err)
	}
	return strings.TrimSpace(line), conn.LocalAddr()
}

func waitPathEvent(t *testing.T, events <-chan PathEvent, want func(PathEvent) bool) PathEvent {
	t.Helper()
	timeout := time.After(loopbackTimeout)
	for {
		select {
		case event := <-events:
			if want(event) {
				return event
			}
		case <-timeout:
			t.Fatal("path event did not arrive")
		}
	}
}

func TestLoopbackChoosesDirectAndFallsBackToTheOnion(t *testing.T) {
	ctx := loopbackContext(t)
	phone := mustIdentity(t, identity.RolePhone)
	desktop := startLoopbackDesktop(t, phone)
	phoneEndpoint := newLoopbackEndpoint(t, phone)
	card := testCard(t, desktop.identity, pairing.Candidate{Type: pairing.CandidateLAN, Address: desktop.endpoint.LocalAddr().String()})
	card.IssuedAt, card.ExpiresAt = time.Now().Add(-time.Minute).UTC().Truncate(time.Second), time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	fallback := &loopbackTor{address: desktop.onionTCP.Addr().String()}

	events := make(chan PathEvent, 16)
	manager, err := New(Config{
		Card:         card,
		Local:        phone,
		Direct:       phoneEndpoint,
		Tor:          fallback,
		ListenPacket: func() (net.PacketConn, error) { return net.ListenPacket("udp", "127.0.0.1:0") },
		Timings:      Timings{Retries: []time.Duration{}},
		OnPath:       func(event PathEvent) { events <- event },
		Logf:         t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	result, err := manager.Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != KindLAN || result.Transport != transport.NameDirect {
		t.Fatalf("Connect = %+v, want the direct path", result)
	}
	if fallback.dials.Load() != 0 {
		t.Fatal("the fallback was dialed while the direct path works")
	}
	name, before := carrier(t, ctx, manager)
	if name != transport.NameDirect {
		t.Fatalf("desktop saw a stream over %q", name)
	}

	// A network change migrates the QUIC session to a new socket and keeps
	// the path.
	path := manager.Active()
	manager.NotifyNetworkChange(true)
	deadline := time.Now().Add(loopbackTimeout)
	for {
		name, after := carrier(t, ctx, manager)
		if name != transport.NameDirect || manager.Active() != path {
			t.Fatalf("after the network change: stream over %q, path %+v", name, manager.Active())
		}
		if after.String() != before.String() && manager.Status().State == StateConnected {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the direct session did not migrate")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// The desktop drops its QUIC endpoint: the manager moves to the onion.
	downAt := time.Now()
	if err := desktop.endpoint.Close(); err != nil {
		t.Fatal(err)
	}
	event := waitPathEvent(t, events, func(event PathEvent) bool { return event.Transport == transport.NameTor })
	if event.Reason != ReasonPathFailed || event.Path != KindTor {
		t.Fatalf("event = %+v", event)
	}
	if switched := manager.Active().Since.Sub(downAt); switched >= time.Second {
		t.Fatalf("fallback took %s after the direct path went down", switched)
	}
	if name, _ := carrier(t, ctx, manager); name != transport.NameTor {
		t.Fatalf("desktop saw a stream over %q after the fallback", name)
	}
}
