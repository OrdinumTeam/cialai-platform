// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"crypto/tls"
	"net"
	"net/netip"
	"slices"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/onion"
)

// These tests run the channel on the real carriers over loopback: the QUIC
// control stream with the endpoints as punchers, and the mutual TLS of the
// onion listener without Tor. Loopback has no NAT, so they prove the wiring,
// not the punch through a real gateway.

type staticRegistry map[string]string

func (registry staticRegistry) RegisteredKey(key string) (string, bool) {
	id, ok := registry[key]
	return id, ok
}

func newEndpoint(t *testing.T, local *identity.Identity) *direct.Endpoint {
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

func TestChannelAndPunchOverDirectQUIC(t *testing.T) {
	keys := newKeys(t)
	desktopEndpoint := newEndpoint(t, keys.desktop)
	listener, err := desktopEndpoint.Listen(direct.ListenConfig{Registry: staticRegistry{keys.phone.PublicKeyString(): keys.phone.ID()}})
	if err != nil {
		t.Fatal(err)
	}
	phoneEndpoint := newEndpoint(t, keys.phone)
	ctx := testContext(t)
	dialed, err := phoneEndpoint.Dial(ctx, listener.Addr().String(), keys.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := listener.Accept(ctx)
	if err != nil {
		t.Fatal(err)
	}

	served := make(chan PunchResult, 1)
	results := make(chan establishResult, 1)
	go func() {
		conn, err := Accept(ctx, accepted.(transport.ControlSession), Config{
			Role: identity.RoleDesktop, LocalKey: keys.desktop.PublicKeyString(), Puncher: desktopEndpoint,
			Handler: Handler{PunchServed: func(result PunchResult) { served <- result }},
		})
		results <- establishResult{conn: conn, err: err}
	}()
	phone, err := Open(ctx, dialed.(transport.ControlSession), Config{
		Role: identity.RolePhone, LocalKey: keys.phone.PublicKeyString(), Puncher: phoneEndpoint,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = phone.Close() })
	desktopResult := waitEstablish(t, results)
	if desktopResult.err != nil {
		t.Fatal(desktopResult.err)
	}
	desktop := desktopResult.conn

	phoneAddress := netip.MustParseAddrPort(phoneEndpoint.LocalAddr().String())
	if _, err := desktop.SendCandidates(ctx, []pairing.Candidate{lan(desktopEndpoint.LocalAddr().String())}, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := phone.SendCandidates(ctx, []pairing.Candidate{lan(phoneAddress.String())}, 0); err != nil {
		t.Fatal(err)
	}
	session, err := phone.Punch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if session.PeerKey() != keys.desktop.PublicKeyString() || session.Transport() != transport.NameDirect {
		t.Fatalf("punched session %s over %s", session.PeerKey(), session.Transport())
	}
	select {
	case result := <-served:
		if result.Err != nil || !slices.Contains(result.Report.Acknowledged, phoneAddress) {
			t.Fatalf("desktop punch = %+v, want an answer from %s", result, phoneAddress)
		}
	case <-time.After(testTimeout):
		t.Fatal("desktop did not report the punch")
	}
	if _, err := desktop.Ping(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestChannelOverTheOnionTLS(t *testing.T) {
	keys := newKeys(t)
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := onion.Listen(raw, keys.desktop, onion.ListenConfig{Registry: staticRegistry{keys.phone.PublicKeyString(): keys.phone.ID()}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	ctx := testContext(t)

	reports := make(chan PathReport, 1)
	results := make(chan establishResult, 1)
	go func() {
		session, err := listener.Accept(ctx)
		if err != nil {
			results <- establishResult{err: err}
			return
		}
		stream, err := session.AcceptStream(ctx)
		if err != nil {
			results <- establishResult{err: err}
			return
		}
		conn, err := Establish(ctx, stream, Config{
			Role: identity.RoleDesktop, LocalKey: keys.desktop.PublicKeyString(),
			Handler: Handler{PathReport: func(report PathReport) { reports <- report }},
		})
		results <- establishResult{conn: conn, err: err}
	}()

	clientConfig, err := identity.ClientConfig(keys.phone, keys.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	tcp, err := (&net.Dialer{}).DialContext(ctx, "tcp", raw.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	tlsConn := tls.Client(tcp, clientConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		t.Fatal(err)
	}
	cards := make(chan candidates.Card, 1)
	phone, err := Establish(ctx, tlsConn, Config{
		Role: identity.RolePhone, LocalKey: keys.phone.PublicKeyString(), PeerKey: keys.desktop.PublicKeyString(),
		Handler: Handler{ReachUpdate: func(card candidates.Card) { cards <- card }},
	})
	if err != nil {
		t.Fatal(err)
	}
	desktopResult := waitEstablish(t, results)
	if desktopResult.err != nil {
		t.Fatal(desktopResult.err)
	}
	desktop := desktopResult.conn

	card := testCard(t, keys.desktop, lan("192.168.1.10:4740"))
	if err := desktop.SendReachUpdate(ctx, card); err != nil {
		t.Fatal(err)
	}
	if got := <-cards; got.Onion != card.Onion || !slices.Equal(got.Candidates, card.Candidates) {
		t.Fatalf("phone stored %+v, desktop sent %+v", got, card)
	}
	rtt, err := phone.Ping(ctx)
	if err != nil {
		t.Fatal(err)
	}
	report := PathReport{Path: transport.NameTor, RTTMillis: rtt.Milliseconds(), Reason: "sem candidatos diretos"}
	if err := phone.ReportPath(ctx, report); err != nil {
		t.Fatal(err)
	}
	if got := <-reports; got != report {
		t.Fatalf("desktop got %+v", got)
	}
	if err := phone.Close(); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, desktop, transport.ErrClosed)
}
