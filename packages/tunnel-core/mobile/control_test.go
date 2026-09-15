// SPDX-License-Identifier: Apache-2.0
package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/testutil"
)

// These tests cover CON-032 in process: the control channel of the rendezvous
// over the fallback, through the real tor.Client, the SOCKS5 stand-in and the
// onion TLS listener of testutil.Desktop, the NAT punch it coordinates and the
// reach card it renews. Loopback has no NAT, so the punch proves the wiring:
// the desktop candidates come only from the control channel.

// useLoopbackCandidates makes the punch announce the phone socket on loopback,
// which the collector skips on purpose.
func useLoopbackCandidates(tunnel *Tunnel) {
	tunnel.punchCandidates = func(_ context.Context, endpoint *direct.Endpoint) ([]pairing.Candidate, error) {
		port := endpoint.LocalAddr().(*net.UDPAddr).Port
		return []pairing.Candidate{{Type: pairing.CandidateLAN, Address: "127.0.0.1:" + strconv.Itoa(port)}}, nil
	}
}

func deadCandidate(t *testing.T) pairing.Candidate {
	t.Helper()
	dead, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := dead.LocalAddr().String()
	_ = dead.Close()
	return pairing.Candidate{Type: pairing.CandidateLAN, Address: address}
}

// storedDesktopOnDisk reads the desktop from mobile-state.json, which the
// running tunnel may be replacing.
func storedDesktopOnDisk(t *testing.T, stateDir, desktopID string) storedDesktop {
	t.Helper()
	raw, err := statedir.ReadFile(filepath.Join(stateDir, mobileStateFile))
	if err != nil {
		t.Fatal(err)
	}
	var state stateFile
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	return state.Desktops[desktopID]
}

func hasCandidate(list []pairing.Candidate, address string) bool {
	return slices.ContainsFunc(list, func(candidate pairing.Candidate) bool { return candidate.Address == address })
}

// eventually waits until done reports true.
func eventually(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(eventTimeout)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen in %s", what, eventTimeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func controlOver(channels []testutil.ControlChannel, name, key string) bool {
	_, found := firstControl(channels, name, key)
	return found
}

func firstControl(channels []testutil.ControlChannel, name, key string) (testutil.ControlChannel, bool) {
	index := slices.IndexFunc(channels, func(channel testutil.ControlChannel) bool {
		return channel.Transport == name && channel.PeerKey == key
	})
	if index < 0 {
		return testutil.ControlChannel{}, false
	}
	return channels[index], true
}

func TestTunnelPunchesFromTheReserveToDirectOverTheOnionControl(t *testing.T) {
	ctx := testContext(t, 2*time.Minute)
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	socks := testutil.StartSOCKS(t)
	socks.Route(desktop.OnionHost(), desktop.OnionTarget())
	// The stored card names a dead candidate, so Connect ends on the fallback
	// and only the control channel reveals the direct listener.
	desktop.SetReach([]pairing.Candidate{deadCandidate(t)})
	desktop.SetControlMode(testutil.ControlRefuse)
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	tunnel.timings = pathmgr.Timings{Retries: []time.Duration{}, Hysteresis: 2 * time.Second, UpgradeInterval: 2 * time.Second}
	useLoopbackCandidates(tunnel)
	if err := tunnel.SetTorEndpoints(socks.Addr(), "", ""); err != nil {
		t.Fatal(err)
	}
	paired := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))
	phoneKey := tunnel.local.PublicKeyString()

	connected := connectTo(t, tunnel, paired.DesktopID)
	if connected.Transport != transport.NameTor || connected.Path != pathmgr.KindTor {
		t.Fatalf("connect %+v, want the fallback", connected)
	}
	page := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, paired.Token, 0)))
	open := page.echo(t, ctx, "over the reserve")
	defer open.CloseNow()
	if upgrade := lastUpgrade(t, desktop); upgrade.Transport != transport.NameTor {
		t.Fatalf("first socket arrived over %q", upgrade.Transport)
	}
	// The first punch ran right after the fallback connected and the desktop
	// refused its control channel, so the path stays on Tor.
	if active := decode[map[string]any](t, must(tunnel.StatusJSON()))["active"].(map[string]any); active["path"] != "tor" {
		t.Fatalf("active path %v before the punch", active)
	}

	mark := events.mark()
	allowedAt := time.Now()
	desktop.SetControlMode(testutil.ControlPunch)
	switched := events.wait(t, mark, "path", field("reason", pathmgr.ReasonPunch))
	switchElapsed := time.Since(allowedAt)
	if switched["transport"] != transport.NameDirect || switched["path"] != string(pathmgr.KindDirect) || switched["desktopId"] != paired.DesktopID {
		t.Fatalf("path event %v", switched)
	}
	if !controlOver(desktop.ControlChannels(), transport.NameTor, phoneKey) {
		t.Fatalf("the punch did not use an onion control channel: %+v", desktop.ControlChannels())
	}

	// The proxy closed the socket of the fallback; the page reconnects over
	// the punched session.
	readContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, _, err := open.Read(readContext)
	cancel()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the socket of the fallback stayed open: %v", err)
	}
	page.echo(t, ctx, "after the punch").CloseNow()
	if upgrade := lastUpgrade(t, desktop); upgrade.Transport != transport.NameDirect {
		t.Fatalf("socket after the punch arrived over %q", upgrade.Transport)
	}
	status := decode[map[string]any](t, must(tunnel.StatusJSON()))
	if active, _ := status["active"].(map[string]any); active["path"] != "direct" || active["transport"] != "direct" {
		t.Fatalf("status after the punch %v", status)
	}
	eventually(t, "the path report of the punch", func() bool {
		return slices.ContainsFunc(desktop.PathReports(), func(report testutil.PathReport) bool {
			return report.Transport == transport.NameTor && report.Report.Path == transport.NameDirect && report.Report.Address == desktop.DirectAddr()
		})
	})
	// The punched session keeps its own control channel over QUIC.
	eventually(t, "the control channel of the punched session", func() bool {
		return controlOver(desktop.OpenControlChannels(), transport.NameDirect, phoneKey)
	})
	t.Logf("tor to direct by punch %s after the desktop accepted control channels; socks dials %d; control channels %d",
		switchElapsed.Round(time.Millisecond), socks.Dials(), len(desktop.ControlChannels()))
}

func TestTunnelRenewsTheReachCardOverTheReserveAndTheDirectSession(t *testing.T) {
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	socks := testutil.StartSOCKS(t)
	socks.Route(desktop.OnionHost(), desktop.OnionTarget())
	desktop.SetReach([]pairing.Candidate{deadCandidate(t)})
	desktop.SetControlMode(testutil.ControlNoPunch)
	stateDir := filepath.Join(t.TempDir(), "phone")
	events := &recorder{}
	tunnel := newTestTunnel(t, stateDir, events)
	tunnel.timings = pathmgr.Timings{Retries: []time.Duration{}}
	useLoopbackCandidates(tunnel)
	if err := tunnel.SetTorEndpoints(socks.Addr(), "", ""); err != nil {
		t.Fatal(err)
	}
	paired := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))
	before := storedDesktopOnDisk(t, stateDir, paired.DesktopID)
	if hasCandidate(before.Candidates, desktop.DirectAddr()) {
		t.Fatalf("the pairing card already names the listener: %+v", before.Candidates)
	}

	// The desktop listener changes while the phone is away: only the renewed
	// card names it.
	desktop.SetReach([]pairing.Candidate{desktop.LANCandidate()})
	if connected := connectTo(t, tunnel, paired.DesktopID); connected.Path != pathmgr.KindTor {
		t.Fatalf("connect %+v, want the fallback", connected)
	}
	eventually(t, "the renewal of the card over the onion", func() bool {
		return hasCandidate(storedDesktopOnDisk(t, stateDir, paired.DesktopID).Candidates, desktop.DirectAddr())
	})
	renewed := storedDesktopOnDisk(t, stateDir, paired.DesktopID)
	if renewed.CandidatesIssuedAt.Before(before.CandidatesIssuedAt) || renewed.Onion != desktop.Onion || renewed.PublicKey != desktop.Identity.PublicKeyString() {
		t.Fatalf("renewed card %+v after %+v", renewed, before)
	}
	if !controlOver(desktop.ControlChannels(), transport.NameTor, tunnel.local.PublicKeyString()) {
		t.Fatalf("no onion control channel: %+v", desktop.ControlChannels())
	}
	// The desktop refused the punch: the card was renewed, the path stays.
	if active := decode[map[string]any](t, must(tunnel.StatusJSON()))["active"].(map[string]any); active["path"] != "tor" {
		t.Fatalf("active path %v", active)
	}
	for _, event := range events.kinds(0, "path") {
		if event["reason"] == pathmgr.ReasonPunch {
			t.Fatalf("a refused punch changed the path: %v", event)
		}
	}
	if err := tunnel.Stop(); err != nil {
		t.Fatal(err)
	}

	// After a restart the stored card reaches the listener without Tor.
	restarted := newTestTunnel(t, stateDir, &recorder{})
	restarted.timings = pathmgr.Timings{Retries: []time.Duration{}}
	if connected := connectTo(t, restarted, paired.DesktopID); connected.Path != pathmgr.KindLAN {
		t.Fatalf("connect with the renewed card %+v", connected)
	}
	eventually(t, "the control channel of the direct session", func() bool {
		return controlOver(desktop.OpenControlChannels(), transport.NameDirect, restarted.local.PublicKeyString())
	})
	moved := pairing.Candidate{Type: pairing.CandidateLAN, Address: "10.20.30.40:4740"}
	if sent := desktop.SetReach([]pairing.Candidate{desktop.LANCandidate(), moved}); sent == 0 {
		t.Fatal("no open control channel received the card")
	}
	eventually(t, "the renewal of the card over QUIC", func() bool {
		return hasCandidate(storedDesktopOnDisk(t, stateDir, paired.DesktopID).Candidates, moved.Address)
	})
	restarted.mu.Lock()
	inMemory := restarted.desktops[paired.DesktopID]
	restarted.mu.Unlock()
	if !hasCandidate(inMemory.Candidates, moved.Address) {
		t.Fatalf("the tunnel kept an old card: %+v", inMemory.Candidates)
	}
	eventually(t, "the path report over QUIC", func() bool {
		return slices.ContainsFunc(desktop.PathReports(), func(report testutil.PathReport) bool {
			return report.Transport == transport.NameDirect && report.Report.Path == transport.NameDirect
		})
	})
}

// TestRevokedPhoneOpensNoControlChannelOverTheOnion dials control connections
// with the tor.Client of the tunnel, as RendezvousPuncher does.
func TestRevokedPhoneOpensNoControlChannelOverTheOnion(t *testing.T) {
	ctx := testContext(t, time.Minute)
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	socks := testutil.StartSOCKS(t)
	socks.Route(desktop.OnionHost(), desktop.OnionTarget())
	tunnel := newTestTunnel(t, t.TempDir(), &recorder{})
	stranger := newTestTunnel(t, t.TempDir(), &recorder{})
	for _, phone := range []*Tunnel{tunnel, stranger} {
		if err := phone.SetTorEndpoints(socks.Addr(), "", ""); err != nil {
			t.Fatal(err)
		}
	}
	paired := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))

	openControl := func(phone *Tunnel) (*rendezvous.Conn, error) {
		conn, err := phone.tor.DialControlTLS(ctx, desktop.OnionHost(), phone.local, desktop.Identity.PublicKey())
		if err != nil {
			return nil, err
		}
		return rendezvous.Establish(ctx, conn, rendezvous.Config{
			Role: identity.RolePhone, LocalKey: phone.local.PublicKeyString(),
			PeerKey: desktop.Identity.PublicKeyString(), HelloTimeout: 5 * time.Second,
		})
	}
	channel, err := openControl(tunnel)
	if err != nil {
		t.Fatalf("registered phone: %v", err)
	}
	defer channel.Close()
	eventually(t, "the onion control channel", func() bool {
		return controlOver(desktop.OpenControlChannels(), transport.NameTor, tunnel.local.PublicKeyString())
	})

	// A phone the desktop does not know opens none, not even while a pairing
	// is active.
	desktop.BeginPair(t, nil, time.Minute)
	if conn, err := openControl(stranger); err == nil {
		_ = conn.Close()
		t.Fatal("an unknown phone opened a control channel")
	}

	if _, err := desktop.Revoke(paired.DeviceID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-channel.Done():
	case <-ctx.Done():
		t.Fatal("revocation left the onion control channel open")
	}
	opened := len(desktop.ControlChannels())
	if conn, err := openControl(tunnel); err == nil {
		_ = conn.Close()
		t.Fatal("a revoked phone opened a control channel")
	}
	if got := desktop.ControlChannels(); len(got) != opened {
		t.Fatalf("the desktop established control channels after the revocation: %+v", got)
	}
	if socks.Dials() < 3 {
		t.Fatalf("control connections did not go through SOCKS: %d dials", socks.Dials())
	}
}

// The production candidates of a punch come from one collector per QUIC
// socket, started by the first punch and closed with the socket.
func TestPunchCandidatesComeFromTheCollectorOfTheSocket(t *testing.T) {
	tunnel := newTestTunnel(t, t.TempDir(), &recorder{})
	tunnel.stunServers = nil
	endpoint, err := tunnel.ensureEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	tunnel.mu.Lock()
	started := tunnel.collector
	tunnel.mu.Unlock()
	if started != nil {
		t.Fatal("the collector started before any punch")
	}
	ctx := testContext(t, 10*time.Second)
	list, err := tunnel.punchCandidates(ctx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(endpoint.LocalAddr().(*net.UDPAddr).Port)
	for _, candidate := range list {
		if _, candidatePort, err := net.SplitHostPort(candidate.Address); err != nil || candidatePort != port || !pairing.ValidCandidate(candidate) {
			t.Fatalf("candidate %+v does not name the QUIC socket on port %s", candidate, port)
		}
	}
	tunnel.mu.Lock()
	collector := tunnel.collector
	tunnel.mu.Unlock()
	if _, err := tunnel.punchCandidates(ctx, endpoint); err != nil {
		t.Fatal(err)
	}
	tunnel.mu.Lock()
	reused := tunnel.collector == collector && collector != nil
	tunnel.mu.Unlock()
	if !reused {
		t.Fatal("a second punch started another collector")
	}
	if err := tunnel.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := tunnel.punchCandidates(ctx, endpoint); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("candidates of a closed socket: %v", err)
	}
}
