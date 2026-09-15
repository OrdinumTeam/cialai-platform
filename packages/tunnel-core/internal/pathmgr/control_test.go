// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"net"
	"slices"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

// controlOutcome is what a desktop control channel saw.
type controlOutcome struct {
	conn    *rendezvous.Conn
	reports chan rendezvous.PathReport
}

// acceptDirectControl accepts one registered QUIC session, answers its data
// streams with the transport name and hands its control channel to the test.
func acceptDirectControl(t *testing.T, desktop *identity.Identity, listener *direct.Listener) <-chan controlOutcome {
	t.Helper()
	outcomes := make(chan controlOutcome, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), loopbackTimeout)
		defer cancel()
		session, err := listener.Accept(ctx)
		if err != nil {
			return
		}
		go func() {
			for {
				stream, err := session.AcceptStream(context.Background())
				if err != nil {
					return
				}
				_, _ = stream.Write([]byte(session.Transport() + "\n"))
			}
		}()
		reports := make(chan rendezvous.PathReport, 4)
		conn, err := rendezvous.Accept(ctx, session.(transport.ControlSession), rendezvous.Config{
			Role: identity.RoleDesktop, LocalKey: desktop.PublicKeyString(),
			Handler: rendezvous.Handler{PathReport: func(report rendezvous.PathReport) { reports <- report }},
		})
		if err != nil {
			return
		}
		outcomes <- controlOutcome{conn: conn, reports: reports}
	}()
	return outcomes
}

func TestDirectSessionKeepsTheControlChannelForCardRenewals(t *testing.T) {
	ctx := loopbackContext(t)
	phone := mustIdentity(t, identity.RolePhone)
	desktopIdentity := mustIdentity(t, identity.RoleDesktop)
	desktopEndpoint := newLoopbackEndpoint(t, desktopIdentity)
	listener, err := desktopEndpoint.Listen(direct.ListenConfig{Registry: staticRegistry{phone.PublicKeyString(): phone.ID()}})
	if err != nil {
		t.Fatal(err)
	}
	outcomes := acceptDirectControl(t, desktopIdentity, listener)
	address := desktopEndpoint.LocalAddr().String()
	card := testCard(t, desktopIdentity, pairing.Candidate{Type: pairing.CandidateLAN, Address: address})
	card.IssuedAt, card.ExpiresAt = time.Now().Add(-time.Minute).UTC().Truncate(time.Second), time.Now().Add(time.Hour).UTC().Truncate(time.Second)

	cards := make(chan candidates.Card, 4)
	manager, err := New(Config{
		Card: card, Local: phone, Direct: newLoopbackEndpoint(t, phone),
		ListenPacket: func() (net.PacketConn, error) { return net.ListenPacket("udp", "127.0.0.1:0") },
		Timings:      Timings{Retries: []time.Duration{}},
		OnCard:       func(card candidates.Card) { cards <- card },
		Logf:         t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if result, err := manager.Connect(ctx); err != nil || result.Path != KindLAN {
		t.Fatalf("Connect = %+v, %v", result, err)
	}

	var outcome controlOutcome
	select {
	case outcome = <-outcomes:
	case <-ctx.Done():
		t.Fatal("the manager did not open the control channel of the direct session")
	}
	select {
	case report := <-outcome.reports:
		if report.Path != transport.NameDirect || report.Address != address {
			t.Fatalf("path report %+v", report)
		}
	case <-ctx.Done():
		t.Fatal("no path report over QUIC")
	}

	moved := pairing.Candidate{Type: pairing.CandidateLAN, Address: "10.1.2.3:4740"}
	renewed, err := candidates.NewCard(card.Desktop, card.Onion, []pairing.Candidate{moved}, time.Now(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := outcome.conn.SendReachUpdate(ctx, renewed); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-cards:
		if !slices.Equal(got.Candidates, renewed.Candidates) || !got.IssuedAt.Equal(renewed.IssuedAt) {
			t.Fatalf("OnCard got %+v", got)
		}
	case <-ctx.Done():
		t.Fatal("the renewed card did not reach OnCard")
	}
	if lan, _ := manager.directCandidates(plan{lan: true}); len(lan) != 1 || lan[0].String() != moved.Address {
		t.Fatalf("the manager dials %v after the renewal", lan)
	}

	// A card of another desktop is refused and never reaches OnCard.
	stranger := testCard(t, mustIdentity(t, identity.RoleDesktop))
	if err := manager.UpdateCard(stranger); err == nil {
		t.Fatal("a card of another desktop was adopted")
	}

	// Releasing the path closes its control channel.
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-outcome.conn.Done():
	case <-ctx.Done():
		t.Fatal("the control channel outlived the manager")
	}
	select {
	case got := <-cards:
		t.Fatalf("OnCard received an unexpected card %+v", got)
	default:
	}
}
