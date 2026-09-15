// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/onion"
)

// DesktopProxySecret is the bridge secret of every Desktop.
const DesktopProxySecret = "desktop-v2-proxy-secret"

// Clock is the adjustable clock of a Desktop: the edge, the device registry
// and the pairing sessions read it, so token rotation can be moved forward.
type Clock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (clock *Clock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return time.Now().Add(clock.offset)
}

// Advance moves the clock forward by d.
func (clock *Clock) Advance(d time.Duration) {
	clock.mu.Lock()
	clock.offset += d
	clock.mu.Unlock()
}

// DesktopOptions configures StartDesktop.
type DesktopOptions struct {
	// OnionListener receives the plain connections of the onion service, such
	// as tor.Desktop.Listener. Nil opens a loopback TCP listener for a SOCKS
	// stand-in to reach.
	OnionListener net.Listener
	// Onion is the onion address with port; empty derives one from a new key.
	Onion string
	// Name is the desktop name; empty means "Mac de Teste".
	Name string
}

// Desktop is an in-process v2 desktop composed from the packages the sidecar
// uses: the Ed25519 identity, the direct QUIC endpoint on loopback, the onion
// TLS listener, the edge with the pairing sessions and the device registry,
// and the fake bridge. The bridge closes the sockets of a revoked device with
// 4401, as the desktop supervisor makes it do.
type Desktop struct {
	Identity *identity.Identity
	Registry *pairing.Registry
	Sessions *pairing.Sessions
	Edge     *edge.Server
	Bridge   *Bridge
	Clock    *Clock
	Name     string
	// Onion is the onion address with port carried by QR and reach card.
	Onion string

	endpoint *direct.Endpoint
	direct   *direct.Listener
	onionRaw net.Listener

	mu     sync.Mutex
	events []DesktopEvent
}

// DesktopEvent is one event the edge emitted.
type DesktopEvent struct {
	Name string
	Data any
}

func StartDesktop(t *testing.T, options DesktopOptions) *Desktop {
	t.Helper()
	if options.Name == "" {
		options.Name = "Mac de Teste"
	}
	local, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	desktop := &Desktop{Identity: local, Clock: &Clock{}, Bridge: StartBridge(t), Name: options.Name, Onion: options.Onion}
	if desktop.Onion == "" {
		key, err := tor.GenerateOnionKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		desktop.Onion = key.Address() + ":443"
	}
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "desktop"))
	if err != nil {
		t.Fatal(err)
	}
	desktop.Registry, err = pairing.OpenRegistry(paths, pairing.DesktopIdentity{ID: local.ID(), Name: options.Name, CreatedAt: desktop.Clock.Now()}, desktop.Clock.Now, nil)
	if err != nil {
		t.Fatal(err)
	}
	desktop.Sessions = pairing.NewSessions(desktop.Clock.Now, nil)

	packetConn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	desktop.endpoint, err = direct.New(direct.Config{PacketConn: packetConn, Identity: local})
	if err != nil {
		t.Fatal(err)
	}
	desktop.direct, err = desktop.endpoint.Listen(direct.ListenConfig{Registry: desktop.Registry, Pairing: desktop.Sessions})
	if err != nil {
		t.Fatal(err)
	}
	desktop.onionRaw = options.OnionListener
	if desktop.onionRaw == nil {
		desktop.onionRaw, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
	}
	onionListener, err := onion.Listen(desktop.onionRaw, local, onion.ListenConfig{Registry: desktop.Registry, Pairing: desktop.Sessions})
	if err != nil {
		t.Fatal(err)
	}

	desktop.Edge, err = edge.New(edge.Config{
		StaticDir: staticSite(t), BridgeURL: desktop.Bridge.URL, ProxySecret: DesktopProxySecret,
		Desktop: pairing.Desktop{ID: local.ID(), Name: options.Name, PublicKey: local.PublicKeyString()},
		Reach: func() edge.ReachCard {
			return edge.ReachCard{Onion: desktop.Onion, Candidates: []pairing.Candidate{desktop.LANCandidate()}}
		},
		Sessions: desktop.Sessions, Devices: desktop.Registry, OnEvent: desktop.record, Now: desktop.Clock.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- desktop.Edge.Serve(transport.NewMultiListener(desktop.direct, onionListener)) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = desktop.Edge.Close(ctx)
		_ = desktop.endpoint.Close()
		select {
		case <-served:
		case <-ctx.Done():
			t.Error("edge did not stop")
		}
	})
	return desktop
}

func staticSite(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "mobile.html"), []byte("<!doctype html><title>Cialai</title><main>Cialai mobile</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func (desktop *Desktop) record(name string, data any) {
	desktop.mu.Lock()
	desktop.events = append(desktop.events, DesktopEvent{Name: name, Data: data})
	desktop.mu.Unlock()
	if changed, ok := data.(map[string]any); ok && name == "devices.changed" && changed["revoked"] == true {
		if deviceID, ok := changed["deviceId"].(string); ok {
			desktop.Bridge.CloseDevice(deviceID, 4401, "Dispositivo revogado.")
		}
	}
}

// Events returns the events the edge emitted so far.
func (desktop *Desktop) Events() []DesktopEvent {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return append([]DesktopEvent(nil), desktop.events...)
}

// DirectAddr is the loopback address of the direct QUIC listener.
func (desktop *Desktop) DirectAddr() string { return desktop.endpoint.LocalAddr().String() }

// OnionTarget is the address the onion service forwards to, which a SOCKS
// stand-in routes the onion name to.
func (desktop *Desktop) OnionTarget() string { return desktop.onionRaw.Addr().String() }

// OnionHost is the onion name without port.
func (desktop *Desktop) OnionHost() string {
	host, _, _ := net.SplitHostPort(desktop.Onion)
	return host
}

// LANCandidate is the direct listener as a QR candidate.
func (desktop *Desktop) LANCandidate() pairing.Candidate {
	return pairing.Candidate{Type: pairing.CandidateLAN, Address: desktop.DirectAddr()}
}

// BeginPair starts a pairing session carrying list as direct candidates and
// returns the CIALAI2 payload.
func (desktop *Desktop) BeginPair(t *testing.T, list []pairing.Candidate, ttl time.Duration) string {
	t.Helper()
	session, err := desktop.Sessions.Begin(pairing.Payload{
		Desktop:    pairing.Desktop{ID: desktop.Identity.ID(), Name: desktop.Name, PublicKey: desktop.Identity.PublicKeyString()},
		Onion:      desktop.Onion,
		Candidates: list,
	}, ttl)
	if err != nil {
		t.Fatal(err)
	}
	return session.Payload
}

// StopDirect closes the direct QUIC endpoint, and with it every direct
// session, while the onion listener keeps serving.
func (desktop *Desktop) StopDirect() error { return desktop.endpoint.Close() }

// Revoke revokes deviceID on every transport, as devices.revoke does.
func (desktop *Desktop) Revoke(deviceID string) (edge.RevokeResult, error) {
	return desktop.Edge.Revoke(deviceID)
}
