// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// controlDesktop serves the rendezvous channel on its own TLS listener, the
// way the sidecar will once it separates the channel from edge connections,
// and punches with the QUIC endpoint of the desktop.
func startControlDesktop(t *testing.T, desktop *loopbackDesktop, reports chan<- rendezvous.PathReport) net.Listener {
	t.Helper()
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	serverTLS, err := identity.ServerConfig(desktop.identity)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			tcp, err := raw.Accept()
			if err != nil {
				return
			}
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), loopbackTimeout)
				defer cancel()
				conn := tls.Server(tcp, serverTLS)
				if err := conn.HandshakeContext(ctx); err != nil {
					_ = tcp.Close()
					return
				}
				peer, err := identity.PeerPublicKey(conn.ConnectionState())
				if err != nil {
					_ = tcp.Close()
					return
				}
				channel, err := rendezvous.Establish(ctx, conn, rendezvous.Config{
					Role: identity.RoleDesktop, LocalKey: desktop.identity.PublicKeyString(),
					PeerKey: identity.EncodePublicKey(peer), Puncher: desktop.endpoint,
					Handler: rendezvous.Handler{PathReport: func(report rendezvous.PathReport) { reports <- report }},
				})
				if err != nil {
					return
				}
				defer channel.Close()
				address := desktop.endpoint.LocalAddr().String()
				if _, err := channel.SendCandidates(ctx, []pairing.Candidate{{Type: pairing.CandidateLAN, Address: address}}, 0); err != nil {
					return
				}
				select {
				case <-channel.Done():
				case <-ctx.Done():
				}
			}()
		}
	}()
	return raw
}

func TestRendezvousPuncherUpgradesTheFallbackOverRealCarriers(t *testing.T) {
	ctx := loopbackContext(t)
	phone := mustIdentity(t, identity.RolePhone)
	desktop := startLoopbackDesktop(t, phone)
	reports := make(chan rendezvous.PathReport, 4)
	control := startControlDesktop(t, desktop, reports)
	phoneEndpoint := newLoopbackEndpoint(t, phone)
	fallback := &loopbackTor{address: desktop.onionTCP.Addr().String()}
	controlTor := &loopbackTor{address: control.Addr().String()}

	// The card has no direct candidate: only the punch finds the direct path.
	card := testCard(t, desktop.identity)
	card.IssuedAt, card.ExpiresAt = time.Now().Add(-time.Minute).UTC().Truncate(time.Second), time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	puncher := &RendezvousPuncher{
		Local:    phone,
		Endpoint: phoneEndpoint,
		OpenControl: func(ctx context.Context, target Desktop) (io.ReadWriteCloser, error) {
			return controlTor.DialTLS(ctx, target.Onion, phone, target.PublicKey)
		},
		Candidates: func(context.Context) ([]pairing.Candidate, error) {
			return []pairing.Candidate{{Type: pairing.CandidateLAN, Address: phoneEndpoint.LocalAddr().String()}}, nil
		},
		Logf: t.Logf,
	}
	events := make(chan PathEvent, 16)
	manager, err := New(Config{
		Card: card, Local: phone, Direct: phoneEndpoint, Tor: fallback, Puncher: puncher,
		Timings: Timings{Retries: []time.Duration{}},
		OnPath:  func(event PathEvent) { events <- event },
		Logf:    t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	result, err := manager.Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Transport != transport.NameTor {
		t.Fatalf("Connect = %+v, want the fallback first", result)
	}
	event := waitPathEvent(t, events, func(event PathEvent) bool { return event.Reason == ReasonPunch })
	if event.Transport != transport.NameDirect || event.Path != KindDirect {
		t.Fatalf("event = %+v", event)
	}
	if name, _ := carrier(t, ctx, manager); name != transport.NameDirect {
		t.Fatalf("desktop saw a stream over %q after the punch", name)
	}
	select {
	case report := <-reports:
		if report.Path != transport.NameDirect || report.Address != desktop.endpoint.LocalAddr().String() {
			t.Fatalf("desktop got report %+v", report)
		}
	case <-ctx.Done():
		t.Fatal("the desktop did not receive the path report")
	}
}

func TestRendezvousPuncherReportsTheFailure(t *testing.T) {
	ctx := loopbackContext(t)
	phone := mustIdentity(t, identity.RolePhone)
	desktop := startLoopbackDesktop(t, phone)
	reports := make(chan rendezvous.PathReport, 4)
	control := startControlDesktop(t, desktop, reports)
	controlTor := &loopbackTor{address: control.Addr().String()}
	target := Desktop{ID: desktop.identity.ID(), PublicKey: desktop.identity.PublicKey()}

	puncher := &RendezvousPuncher{
		Local:    phone,
		Endpoint: newLoopbackEndpoint(t, phone),
		OpenControl: func(ctx context.Context, target Desktop) (io.ReadWriteCloser, error) {
			return controlTor.DialTLS(ctx, target.Onion, phone, target.PublicKey)
		},
		Candidates: func(context.Context) ([]pairing.Candidate, error) { return nil, errors.New("stun timed out") },
	}
	if session, err := puncher.Punch(ctx, target); err == nil || session != nil {
		t.Fatalf("Punch = %v, %v", session, err)
	}
	select {
	case report := <-reports:
		if report.Path != transport.NameTor || report.Reason == "" {
			t.Fatalf("desktop got report %+v", report)
		}
	case <-ctx.Done():
		t.Fatal("the desktop did not receive the failure report")
	}
	if _, err := (&RendezvousPuncher{}).Punch(ctx, target); err == nil {
		t.Fatal("an incomplete puncher must refuse to punch")
	}
	if long := reportReason(errors.New(string(make([]byte, 300)) + "ã")); len(long) > maxReportBytes {
		t.Fatalf("reason has %d bytes", len(long))
	}
}
