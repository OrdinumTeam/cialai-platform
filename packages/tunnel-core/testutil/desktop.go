// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
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

// ControlMode selects how a Desktop answers new control channels.
type ControlMode int32

const (
	// ControlPunch sends the reach card and then the candidates after hello
	// and serves punches with the direct endpoint, as the sidecar does.
	ControlPunch ControlMode = iota
	// ControlNoPunch sends the card and the candidates but refuses punches.
	ControlNoPunch
	// ControlRefuse closes the control stream as soon as it arrives.
	ControlRefuse
)

// ControlChannel is one control channel a Desktop established, at the moment
// the hello exchange finished.
type ControlChannel struct {
	Transport string
	PeerKey   string
	At        time.Time
}

// PathReport is a path report received on a control channel.
type PathReport struct {
	Transport string
	Report    rendezvous.PathReport
}

// Desktop is an in-process v2 desktop composed from the packages the sidecar
// uses: the Ed25519 identity, the direct QUIC endpoint on loopback, the onion
// TLS listener with control connections, the edge with the pairing sessions
// and the device registry, the rendezvous channel on both carriers and the
// fake bridge. The bridge closes the sockets of a revoked device with 4401, as
// the desktop supervisor makes it do.
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
	ctx      context.Context
	cancel   context.CancelFunc
	mode     atomic.Int32

	mu       sync.Mutex
	events   []DesktopEvent
	reach    []pairing.Candidate
	controls map[*rendezvous.Conn]ControlChannel
	opened   []ControlChannel
	reports  []PathReport
	serving  sync.WaitGroup
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
	desktop := &Desktop{
		Identity: local, Clock: &Clock{}, Bridge: StartBridge(t), Name: options.Name, Onion: options.Onion,
		controls: make(map[*rendezvous.Conn]ControlChannel),
	}
	desktop.ctx, desktop.cancel = context.WithCancel(context.Background())
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
	onionListener, err := onion.Listen(desktop.onionRaw, local, onion.ListenConfig{Registry: desktop.Registry, Pairing: desktop.Sessions, Control: true})
	if err != nil {
		t.Fatal(err)
	}

	desktop.Edge, err = edge.New(edge.Config{
		StaticDir: staticSite(t), BridgeURL: desktop.Bridge.URL, ProxySecret: DesktopProxySecret,
		Desktop: pairing.Desktop{ID: local.ID(), Name: options.Name, PublicKey: local.PublicKeyString()},
		Reach: func() edge.ReachCard {
			return edge.ReachCard{Onion: desktop.Onion, Candidates: desktop.reachCandidates()}
		},
		Sessions: desktop.Sessions, Devices: desktop.Registry, OnEvent: desktop.record, Now: desktop.Clock.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	desktop.serving.Go(func() {
		for {
			session, err := onionListener.AcceptControl(desktop.ctx)
			if err != nil {
				return
			}
			desktop.serving.Go(func() { desktop.serveControl(session) })
		}
	})
	directListener := &controlListener{Listener: desktop.direct, desktop: desktop}
	go func() { served <- desktop.Edge.Serve(transport.NewMultiListener(directListener, onionListener)) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		desktop.cancel()
		_ = desktop.Edge.Close(ctx)
		_ = desktop.endpoint.Close()
		select {
		case <-served:
		case <-ctx.Done():
			t.Error("edge did not stop")
		}
		desktop.serving.Wait()
	})
	return desktop
}

// controlListener accepts the control stream of every direct session the
// edge accepts, as the sidecar does.
type controlListener struct {
	transport.Listener
	desktop *Desktop
}

func (listener *controlListener) Accept(ctx context.Context) (transport.Session, error) {
	session, err := listener.Listener.Accept(ctx)
	if err != nil {
		return nil, err
	}
	if control, ok := session.(transport.ControlSession); ok {
		listener.desktop.serving.Go(func() { listener.desktop.serveControl(control) })
	}
	return session, nil
}

// serveControl runs one control channel in the current ControlMode until it
// or the desktop ends.
func (desktop *Desktop) serveControl(session transport.ControlSession) {
	stream, err := session.AcceptControl(desktop.ctx)
	if err != nil {
		return
	}
	mode := ControlMode(desktop.mode.Load())
	if mode == ControlRefuse {
		_ = stream.Close()
		return
	}
	var puncher transport.Puncher
	if mode == ControlPunch {
		puncher = desktop.endpoint
	}
	name := session.Transport()
	conn, err := rendezvous.Establish(desktop.ctx, stream, rendezvous.Config{
		Role: identity.RoleDesktop, LocalKey: desktop.Identity.PublicKeyString(), Puncher: puncher,
		Handler: rendezvous.Handler{PathReport: func(report rendezvous.PathReport) {
			desktop.mu.Lock()
			desktop.reports = append(desktop.reports, PathReport{Transport: name, Report: report})
			desktop.mu.Unlock()
		}},
	})
	if err != nil {
		return
	}
	defer conn.Close()
	channel := ControlChannel{Transport: name, PeerKey: session.PeerKey(), At: time.Now()}
	desktop.mu.Lock()
	desktop.controls[conn] = channel
	desktop.opened = append(desktop.opened, channel)
	desktop.mu.Unlock()
	defer func() {
		desktop.mu.Lock()
		delete(desktop.controls, conn)
		desktop.mu.Unlock()
	}()
	if desktop.sendCard(conn) == nil {
		ctx, cancel := context.WithTimeout(desktop.ctx, 5*time.Second)
		_, _ = conn.SendCandidates(ctx, []pairing.Candidate{desktop.LANCandidate()}, 0)
		cancel()
	}
	select {
	case <-conn.Done():
	case <-desktop.ctx.Done():
	}
}

// sendCard sends the current reach card on conn.
func (desktop *Desktop) sendCard(conn *rendezvous.Conn) error {
	card, err := candidates.NewCard(
		pairing.Desktop{ID: desktop.Identity.ID(), Name: desktop.Name, PublicKey: desktop.Identity.PublicKeyString()},
		desktop.Onion, desktop.reachCandidates(), desktop.Clock.Now(), 0,
	)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(desktop.ctx, 5*time.Second)
	defer cancel()
	return conn.SendReachUpdate(ctx, card)
}

func (desktop *Desktop) reachCandidates() []pairing.Candidate {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	if desktop.reach == nil {
		return []pairing.Candidate{desktop.LANCandidate()}
	}
	return slices.Clone(desktop.reach)
}

// SetControlMode changes how new control channels are answered.
func (desktop *Desktop) SetControlMode(mode ControlMode) { desktop.mode.Store(int32(mode)) }

// SetReach replaces the candidates of the reach card, which pairing returns
// and control channels renew, and sends the renewed card on every open control
// channel. Control channels still announce the direct listener as candidate.
// It returns how many channels received the card.
func (desktop *Desktop) SetReach(list []pairing.Candidate) int {
	desktop.mu.Lock()
	desktop.reach = slices.Clone(list)
	if desktop.reach == nil {
		desktop.reach = []pairing.Candidate{}
	}
	conns := make([]*rendezvous.Conn, 0, len(desktop.controls))
	for conn := range desktop.controls {
		conns = append(conns, conn)
	}
	desktop.mu.Unlock()
	sent := 0
	for _, conn := range conns {
		if desktop.sendCard(conn) == nil {
			sent++
		}
	}
	return sent
}

// ControlChannels lists every control channel established so far, in order.
func (desktop *Desktop) ControlChannels() []ControlChannel {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return slices.Clone(desktop.opened)
}

// OpenControlChannels lists the control channels still open.
func (desktop *Desktop) OpenControlChannels() []ControlChannel {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	channels := make([]ControlChannel, 0, len(desktop.controls))
	for _, channel := range desktop.controls {
		channels = append(channels, channel)
	}
	return channels
}

// PathReports lists the path reports received on control channels.
func (desktop *Desktop) PathReports() []PathReport {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return slices.Clone(desktop.reports)
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
