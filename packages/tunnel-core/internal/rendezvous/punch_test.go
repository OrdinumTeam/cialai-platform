// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"context"
	"errors"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

var (
	phoneList = []pairing.Candidate{
		lan("192.168.1.20:50000"),
		{Type: pairing.CandidateSTUN, Address: "203.0.113.20:50000"},
	}
	desktopList = []pairing.Candidate{
		lan("192.168.0.10:4740"),
		{Type: pairing.CandidateMapped, Address: "198.51.100.10:4740"},
	}
	// phoneBehindNAT is the reflected address the NAT lets through once the
	// desktop sent opening packets to it.
	phoneBehindNAT = netip.MustParseAddrPort("203.0.113.20:50000")
)

func TestPunchOpensDesktopBindingsBeforeThePhoneDials(t *testing.T) {
	keys := newKeys(t)
	nat := newFakeNAT()
	phonePuncher := &fakePuncher{nat: nat, self: []netip.AddrPort{phoneBehindNAT}}
	desktopPuncher := &fakePuncher{nat: nat}
	served := make(chan PunchResult, 1)
	reports := make(chan PathReport, 1)
	phone, desktop := connPair(t, keys, func(config *Config) {
		config.Puncher = phonePuncher
	}, func(config *Config) {
		config.Puncher = desktopPuncher
		config.Handler.PunchServed = func(result PunchResult) { served <- result }
		config.Handler.PathReport = func(report PathReport) { reports <- report }
	})
	ctx := testContext(t)
	if _, err := phone.SendCandidates(ctx, phoneList, 0); err != nil {
		t.Fatal(err)
	}
	// The desktop answers later than the phone asks: Punch waits for it.
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, _ = desktop.SendCandidates(ctx, desktopList, 0)
	}()

	session, err := phone.Punch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if session.PeerKey() != keys.desktop.PublicKeyString() {
		t.Fatalf("direct session pinned %q", session.PeerKey())
	}
	punched, _ := desktopPuncher.calls()
	if len(punched) != 1 || !slices.Equal(punched[0], addrPorts(phoneList...)) {
		t.Fatalf("desktop punched %v, want the phone list", punched)
	}
	if _, dialed := phonePuncher.calls(); len(dialed) != 1 || !slices.Equal(dialed[0], addrPorts(desktopList...)) {
		t.Fatalf("phone dialed %v, want the desktop list", dialed)
	}
	select {
	case result := <-served:
		if result.Err != nil || result.Report.Sent != len(phoneList) || result.Request == 0 || !slices.Equal(result.Candidates, addrPorts(phoneList...)) {
			t.Fatalf("punch result = %+v", result)
		}
	case <-time.After(testTimeout):
		t.Fatal("desktop did not report the punch")
	}

	report := PathReport{Path: transport.NameDirect, Address: "198.51.100.10:4740"}
	if err := phone.ReportPath(ctx, report); err != nil {
		t.Fatal(err)
	}
	if got := <-reports; got != report {
		t.Fatalf("desktop got %+v", got)
	}
}

func TestPunchRefusalsKeepTheChannel(t *testing.T) {
	for name, test := range map[string]struct {
		desktopPuncher bool
		phoneList      []pairing.Candidate
		// ageDesktop runs once the desktop holds the phone list.
		ageDesktop time.Duration
		reason     string
	}{
		"desktop without puncher": {phoneList: phoneList, reason: RefusedUnsupported},
		"phone list expired on the desktop": {
			desktopPuncher: true, phoneList: phoneList, ageDesktop: time.Minute, reason: RefusedExpired,
		},
		"phone without candidates": {desktopPuncher: true, phoneList: []pairing.Candidate{}, reason: RefusedNoCandidates},
	} {
		t.Run(name, func(t *testing.T) {
			keys := newKeys(t)
			nat := newFakeNAT()
			phonePuncher := &fakePuncher{nat: nat, self: []netip.AddrPort{phoneBehindNAT}}
			desktopPuncher := &fakePuncher{nat: nat}
			desktopClock := newFakeClock()
			received := make(chan CandidateSet, 1)
			phone, desktop := connPair(t, keys, func(config *Config) {
				config.Puncher = phonePuncher
			}, func(config *Config) {
				if test.desktopPuncher {
					config.Puncher = desktopPuncher
				}
				config.Now = desktopClock.Now
				config.Handler.Candidates = func(set CandidateSet) { received <- set }
			})
			ctx := testContext(t)
			if _, err := desktop.SendCandidates(ctx, desktopList, 0); err != nil {
				t.Fatal(err)
			}
			if _, err := phone.SendCandidates(ctx, test.phoneList, time.Minute); err != nil {
				t.Fatal(err)
			}
			<-received
			desktopClock.Advance(test.ageDesktop)

			_, err := phone.Punch(ctx)
			if !errors.Is(err, ErrPunchRefused) || !strings.HasSuffix(err.Error(), test.reason) {
				t.Fatalf("Punch error = %v, want refusal %s", err, test.reason)
			}
			if punched, _ := desktopPuncher.calls(); len(punched) != 0 {
				t.Fatalf("desktop punched %v after refusing", punched)
			}
			if _, dialed := phonePuncher.calls(); len(dialed) != 0 {
				t.Fatalf("phone dialed %v after a refusal", dialed)
			}
			if _, err := phone.Ping(ctx); err != nil {
				t.Fatalf("refusal broke the channel: %v", err)
			}
		})
	}
}

func TestPunchNeedsFreshLocalCandidates(t *testing.T) {
	keys := newKeys(t)
	nat := newFakeNAT()
	phoneClock := newFakeClock()
	phonePuncher := &fakePuncher{nat: nat, self: []netip.AddrPort{phoneBehindNAT}}
	desktopPuncher := &fakePuncher{nat: nat}
	phone, desktop := connPair(t, keys, func(config *Config) {
		config.Puncher = phonePuncher
		config.Now = phoneClock.Now
	}, func(config *Config) { config.Puncher = desktopPuncher })
	ctx := testContext(t)
	if _, err := desktop.SendCandidates(ctx, desktopList, MaxCandidateTTL); err != nil {
		t.Fatal(err)
	}
	if _, err := phone.Punch(ctx); !errors.Is(err, ErrCandidatesExpired) {
		t.Fatalf("Punch without local candidates = %v", err)
	}
	if _, err := phone.SendCandidates(ctx, phoneList, MinCandidateTTL); err != nil {
		t.Fatal(err)
	}
	phoneClock.Advance(MinCandidateTTL)
	if _, ok := phone.LocalCandidates(); ok {
		t.Fatal("expired local candidates reported as fresh")
	}
	if _, err := phone.Punch(ctx); !errors.Is(err, ErrCandidatesExpired) {
		t.Fatalf("Punch with expired local candidates = %v", err)
	}
	if _, err := desktop.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if punched, _ := desktopPuncher.calls(); len(punched) != 0 {
		t.Fatalf("desktop punched %v for an expired list", punched)
	}
}

func TestPunchWaitsForFreshDesktopCandidates(t *testing.T) {
	keys := newKeys(t)
	nat := newFakeNAT()
	phoneClock := newFakeClock()
	phonePuncher := &fakePuncher{nat: nat, self: []netip.AddrPort{phoneBehindNAT}}
	received := make(chan CandidateSet, 2)
	phone, desktop := connPair(t, keys, func(config *Config) {
		config.Puncher = phonePuncher
		config.Now = phoneClock.Now
		config.Handler.Candidates = func(set CandidateSet) { received <- set }
	}, func(config *Config) { config.Puncher = &fakePuncher{nat: nat} })
	ctx := testContext(t)
	if _, err := phone.SendCandidates(ctx, phoneList, MaxCandidateTTL); err != nil {
		t.Fatal(err)
	}
	stale, err := desktop.SendCandidates(ctx, []pairing.Candidate{lan("192.168.0.99:4740")}, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	<-received
	phoneClock.Advance(30 * time.Second)
	if _, ok := phone.PeerCandidates(); ok {
		t.Fatal("expired desktop candidates reported as fresh")
	}

	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := phone.Punch(short); !errors.Is(err, ErrCandidatesExpired) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Punch with expired desktop candidates = %v", err)
	}

	type outcome struct {
		session transport.Session
		err     error
	}
	done := make(chan outcome, 1)
	go func() {
		session, err := phone.Punch(ctx)
		done <- outcome{session: session, err: err}
	}()
	time.Sleep(20 * time.Millisecond)
	fresh, err := desktop.SendCandidates(ctx, desktopList, 0)
	if err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil {
		t.Fatal(result.err)
	}
	_, dialed := phonePuncher.calls()
	if len(dialed) != 1 || !slices.Equal(dialed[0], fresh.AddrPorts()) || slices.Equal(dialed[0], stale.AddrPorts()) {
		t.Fatalf("phone dialed %v, want only the fresh list", dialed)
	}
}

func TestDesktopRefusesStaleAndConcurrentPunches(t *testing.T) {
	keys := newKeys(t)
	release := make(chan struct{})
	puncher := &fakePuncher{nat: newFakeNAT(), block: release}
	served := make(chan PunchResult, 2)
	_, peer := connWithRaw(t, keys, identity.RoleDesktop, func(config *Config) {
		config.Puncher = puncher
		config.Handler.PunchServed = func(result PunchResult) { served <- result }
	})
	request := func(candidates uint64) message {
		return message{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: candidates}}
	}
	expectAck := func(accepted bool, reason string) {
		t.Helper()
		ack := peer.expect(typePunchAck)
		if ack.PunchAck.Request != peer.seq || ack.PunchAck.Accepted != accepted || ack.PunchAck.Reason != reason {
			t.Fatalf("ack = %+v for request %d, want accepted=%v reason=%q", ack.PunchAck, peer.seq, accepted, reason)
		}
	}

	// The raw phone numbers its frames from the hello: the lists are frames 2
	// and 3, the requests follow.
	peer.mustSend(candidatesMessage(phoneList[0]))
	peer.mustSend(candidatesMessage(phoneList...))
	peer.mustSend(request(2))
	expectAck(false, RefusedStale)
	peer.mustSend(request(3))
	expectAck(true, "")
	peer.mustSend(request(3))
	expectAck(false, RefusedBusy)
	close(release)
	if result := <-served; result.Request != 5 || result.Err != nil {
		t.Fatalf("served %+v, want request 5", result)
	}
	peer.mustSend(request(3)) // seq 7
	expectAck(true, "")
	if result := <-served; result.Request != 7 {
		t.Fatalf("served %+v, want request 7", result)
	}
	if punched, _ := puncher.calls(); len(punched) != 2 || !slices.Equal(punched[1], addrPorts(phoneList...)) {
		t.Fatalf("desktop punched %v", punched)
	}
}

func TestCloseCancelsAPunchInProgress(t *testing.T) {
	keys := newKeys(t)
	puncher := &fakePuncher{nat: newFakeNAT(), block: make(chan struct{})}
	served := make(chan PunchResult, 1)
	conn, peer := connWithRaw(t, keys, identity.RoleDesktop, func(config *Config) {
		config.Puncher = puncher
		config.PunchTimeout = time.Hour
		config.Handler.PunchServed = func(result PunchResult) { served <- result }
	})
	peer.mustSend(candidatesMessage(phoneList...))
	peer.mustSend(message{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: 2}})
	peer.expect(typePunchAck)
	closed := make(chan struct{})
	go func() {
		_ = conn.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(testTimeout):
		t.Fatal("Close waited for a blocked punch")
	}
	if result := <-served; !errors.Is(result.Err, context.Canceled) {
		t.Fatalf("punch result error = %v, want cancellation", result.Err)
	}
}

func TestPunchReturnsDialFailures(t *testing.T) {
	keys := newKeys(t)
	nat := newFakeNAT()
	// The NAT only opens for an address the phone never announced.
	phonePuncher := &fakePuncher{nat: nat, self: []netip.AddrPort{netip.MustParseAddrPort("203.0.113.99:1")}}
	phone, desktop := connPair(t, keys, func(config *Config) {
		config.Puncher = phonePuncher
		config.PunchTimeout = 100 * time.Millisecond
	}, func(config *Config) { config.Puncher = &fakePuncher{nat: nat} })
	ctx := testContext(t)
	if _, err := desktop.SendCandidates(ctx, desktopList, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := phone.SendCandidates(ctx, phoneList, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := phone.Punch(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Punch error = %v, want the punch timeout", err)
	}
	if err := phone.ReportPath(ctx, PathReport{Path: transport.NameTor, Reason: "furo de NAT sem resposta"}); err != nil {
		t.Fatal(err)
	}
	empty, err := desktop.SendCandidates(ctx, nil, 0)
	if err != nil || len(empty.Candidates) != 0 {
		t.Fatalf("withdraw = %+v, %v", empty, err)
	}
	if _, err := phone.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := phone.Punch(ctx); !errors.Is(err, transport.ErrNoCandidates) {
		t.Fatalf("Punch toward an empty desktop list = %v", err)
	}
}
