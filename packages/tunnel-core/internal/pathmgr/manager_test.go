// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

func TestLocalPathWinsEvenWhenTheInternetAnswersFirst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeAnswer)
		h.direct.setDelay(lanAddress, time.Second)
		h.direct.set(stunAddress, modeAnswer)

		result := h.mustConnect(KindLAN)
		if result.Transport != transport.NameDirect || result.ElapsedMillis != 1000 || result.DesktopID != h.card.Desktop.ID {
			t.Fatalf("result = %+v", result)
		}
		if h.tor.dialCount() != 0 || len(h.puncher.callTimes()) != 0 {
			t.Fatal("a direct path must not touch the fallback")
		}
		if internet := h.direct.session(0); internet.remote.String() != stunAddress || !internet.ended() {
			t.Fatal("the internet session that lost to the local one must be closed")
		}
		if active := h.expectActive(KindLAN); active.Address != lanAddress {
			t.Fatalf("active = %+v", active)
		}
		if events := h.events.pathList(); len(events) != 1 || events[0].event != (PathEvent{DesktopID: h.card.Desktop.ID, Transport: "direct", Path: KindLAN, Reason: ReasonConnect}) {
			t.Fatalf("events = %+v", events)
		}
	})
}

func TestInternetPathWaitsOnlyForTheLocalBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeHang)
		h.direct.set(stunAddress, modeAnswer)

		result := h.mustConnect(KindDirect)
		if result.ElapsedMillis != 1500 {
			t.Fatalf("elapsed = %d ms, want the 1.5 s local budget", result.ElapsedMillis)
		}
		calls := h.direct.callList()
		if len(calls) != 2 {
			t.Fatalf("calls = %+v", calls)
		}
		for _, call := range calls {
			if call.candidates[0].String() == lanAddress && !errors.Is(call.err, context.Canceled) {
				t.Fatalf("local dial ended with %v, want its budget to cancel it", call.err)
			}
		}
	})
}

func TestDirectPathIsChosenWhenAvailable(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withCard(pairing.Candidate{Type: pairing.CandidateSTUN, Address: stunAddress}))
		h.direct.set(stunAddress, modeAnswer)

		result := h.mustConnect(KindDirect)
		if result.ElapsedMillis != 0 {
			t.Fatalf("elapsed = %d ms", result.ElapsedMillis)
		}
		h.clock.Advance(30 * time.Minute)
		if h.tor.dialCount() != 0 || len(h.puncher.callTimes()) != 0 || len(h.direct.callList()) != 1 {
			t.Fatalf("a working direct path must stay alone: tor %d, punches %d, dials %d",
				h.tor.dialCount(), len(h.puncher.callTimes()), len(h.direct.callList()))
		}
		h.expectActive(KindDirect)
	})
}

func TestFallbackAfterTheDirectBudgetsThenPunch(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeHang)
		h.direct.set(stunAddress, modeHang)
		h.puncher.err, h.puncher.answer = nil, netip.MustParseAddrPort(punchAddress)

		result := h.mustConnect(KindTor)
		if result.Transport != transport.NameTor || result.ElapsedMillis != DefaultDirectBudget.Milliseconds() {
			t.Fatalf("result = %+v, want the fallback after the %s direct budget", result, DefaultDirectBudget)
		}
		h.clock.Advance(punchDelay)
		active := h.expectActive(KindDirect)
		if active.Address != punchAddress || active.Transport != transport.NameDirect {
			t.Fatalf("active = %+v, want the punched session", active)
		}
		events := h.events.pathList()
		want := []PathEvent{
			{DesktopID: h.card.Desktop.ID, Transport: "tor", Path: KindTor, Reason: ReasonConnect},
			{DesktopID: h.card.Desktop.ID, Transport: "direct", Path: KindDirect, Reason: ReasonPunch},
		}
		if len(events) != 2 || events[0].event != want[0] || events[1].event != want[1] || events[1].at != DefaultDirectBudget+punchDelay {
			t.Fatalf("events = %+v", events)
		}
		if punches := h.puncher.callTimes(); !slices.Equal(punches, []time.Duration{DefaultDirectBudget}) {
			t.Fatalf("punches at %v", punches)
		}
	})
}

func TestTorBootstrapProgressIsVisible(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.tor.progress = []int{10, 45, 100}

		result := h.mustConnect(KindTor)
		if result.ElapsedMillis != 2000 {
			t.Fatalf("elapsed = %d ms, want two bootstrap polls", result.ElapsedMillis)
		}
		want := []TorStatus{{TorBootstrapping, 10}, {TorBootstrapping, 45}, {TorReady, 100}}
		if got := h.events.torList(); !slices.Equal(got, want) {
			t.Fatalf("tor events = %+v, want %+v", got, want)
		}
		if status := h.manager.Status(); status.Tor != (TorStatus{TorReady, 100}) || status.State != StateConnected {
			t.Fatalf("status = %+v", status)
		}
	})
}

func TestEveryPathFailing(t *testing.T) {
	socksRefused := &net.OpError{Op: "socks connect", Net: "tcp", Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}}
	cases := []struct {
		name    string
		options []harnessOption
		setup   func(*harness)
		code    string
		elapsed time.Duration
	}{
		{
			name:  "desktop silent over a ready Tor",
			setup: func(h *harness) { h.tor.setDialErr(errors.New("general SOCKS server failure")) },
			code:  CodeNoPath, elapsed: 20 * time.Second,
		},
		{
			name: "every dial hangs",
			setup: func(h *harness) {
				h.direct.set(lanAddress, modeHang)
				h.direct.set(stunAddress, modeHang)
				h.tor.dialHang = true
			},
			code: CodeNoPath, elapsed: DefaultDirectBudget + DefaultTorBudget,
		},
		{
			name:  "tor not running",
			setup: func(h *harness) { h.tor.statusErr = tor.ErrNoEndpoints },
			code:  CodeReserveUnavailable, elapsed: 0,
		},
		{
			name: "tor socks refused without a control port",
			setup: func(h *harness) {
				h.tor.statusErr = tor.ErrNoControlEndpoint
				h.tor.setDialErr(socksRefused)
			},
			code: CodeReserveUnavailable, elapsed: 0,
		},
		{
			name:  "tor still bootstrapping",
			setup: func(h *harness) { h.tor.progress = []int{5, 40} },
			code:  CodeReservePreparing, elapsed: 20 * time.Second,
		},
		{
			name:    "no tor configured",
			options: []harnessOption{withoutTor()},
			code:    CodeReserveUnavailable, elapsed: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				h := newHarness(t, tc.options...)
				if tc.setup != nil {
					tc.setup(h)
				}
				outcome := h.await(h.connect(), time.Minute)
				if Code(outcome.err) != tc.code || outcome.at != tc.elapsed {
					t.Fatalf("Connect = %v at %s, want %s at %s", outcome.err, outcome.at, tc.code, tc.elapsed)
				}
				if h.manager.Active().Transport != "" {
					t.Fatal("no path may be active")
				}
				status := h.manager.Status()
				if status.State != StateOffline || status.Error != tc.code {
					t.Fatalf("status = %+v", status)
				}
				if last := h.lastEvent().event; last.Path != KindNone || last.Reason != tc.code || last.Transport != "" {
					t.Fatalf("last event = %+v", last)
				}
				dials := len(h.direct.callList())
				if _, err := h.manager.DialContext(context.Background(), "tcp", "cialai-desktop:47400"); Code(err) != tc.code {
					t.Fatalf("DialContext = %v, want %s", err, tc.code)
				}
				if len(h.direct.callList()) != dials {
					t.Fatal("DialContext must not start an evaluation while offline")
				}
			})
		})
	}
}

func TestOfflineRetriesBackOffThenStop(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutTor())
		outcome := h.await(h.connect(), time.Second)
		if Code(outcome.err) != CodeReserveUnavailable {
			t.Fatalf("Connect = %v", outcome.err)
		}
		h.clock.Advance(10 * time.Minute)
		var starts []time.Duration
		for _, call := range h.direct.callList() {
			if call.candidates[0].String() == lanAddress {
				starts = append(starts, call.at)
			}
		}
		want := []time.Duration{0, 2 * time.Second, 6 * time.Second, 14 * time.Second, 30 * time.Second}
		if !slices.Equal(starts, want) {
			t.Fatalf("evaluations at %v, want %v", starts, want)
		}
		if events := h.events.pathList(); len(events) != 1 {
			t.Fatalf("repeated offline events: %+v", events)
		}

		// A path that comes back during the retries is adopted.
		h.direct.set(lanAddress, modeAnswer)
		h.manager.NotifyForeground(true)
		h.expectActive(KindLAN)
		if h.lastEvent().event.Reason != ReasonForeground {
			t.Fatalf("event = %+v", h.lastEvent())
		}
	})
}

func TestRetryReconnectsAfterALostPath(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutTor())
		h.direct.set(lanAddress, modeAnswer)
		h.mustConnect(KindLAN)

		h.direct.set(lanAddress, modeRefuse)
		h.direct.session(0).end(errors.New("idle timeout"))
		synctest.Wait()
		if status := h.manager.Status(); status.State != StateOffline || status.Error != CodeReserveUnavailable {
			t.Fatalf("status = %+v", status)
		}
		h.direct.set(lanAddress, modeAnswer)
		h.clock.Advance(2 * time.Second)
		h.expectActive(KindLAN)
		if last := h.lastEvent(); last.event.Reason != ReasonRetry || last.at != 2*time.Second {
			t.Fatalf("last event = %+v", last)
		}
	})
}

func TestActivePathFailureMovesToTheNextPathAtOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeAnswer)
		h.direct.set(stunAddress, modeAnswer)
		h.mustConnect(KindLAN)

		h.clock.Advance(10 * time.Second)
		lostAt := h.clock.Elapsed()
		h.direct.set(lanAddress, modeRefuse)
		h.direct.sessionTo(lanAddress).end(errors.New("network is unreachable"))
		active := h.expectActive(KindDirect)
		if switched := active.Since.Sub(epoch) - lostAt; switched >= time.Second {
			t.Fatalf("switch took %s after the failure", switched)
		}
		calls := h.direct.callList()
		if last := calls[len(calls)-1]; len(last.candidates) != 1 || last.candidates[0].String() != stunAddress {
			t.Fatalf("failover after the local path dialed %v, want only the internet candidates", last.candidates)
		}

		h.clock.Advance(10 * time.Second)
		lostAt = h.clock.Elapsed()
		dials := len(h.direct.callList())
		h.direct.sessionTo(stunAddress).end(errors.New("idle timeout"))
		active = h.expectActive(KindTor)
		if switched := active.Since.Sub(epoch) - lostAt; switched >= time.Second {
			t.Fatalf("switch took %s after the failure", switched)
		}
		if len(h.direct.callList()) != dials {
			t.Fatal("failover after the internet path must go straight to the fallback")
		}
		if last := h.lastEvent(); last.event.Reason != ReasonPathFailed || last.event.Transport != transport.NameTor || last.at != lostAt {
			t.Fatalf("last event = %+v", last)
		}
		if len(h.puncher.callTimes()) != 0 {
			t.Fatal("no punch right after a switch")
		}
	})
}

func TestFailureDuringHysteresisDoesNotWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withCard(pairing.Candidate{Type: pairing.CandidateSTUN, Address: stunAddress}))
		h.puncher.err, h.puncher.answer = nil, netip.MustParseAddrPort(punchAddress)
		h.mustConnect(KindTor)
		h.clock.Advance(punchDelay)
		h.expectActive(KindDirect)

		// 30 s after the switch to the punched path, well inside the
		// hysteresis, the punched path fails.
		h.puncher.set(netip.AddrPort{}, errors.New("punch refused"))
		h.clock.AdvanceTo(30 * time.Second)
		h.puncher.lastSession().end(errors.New("idle timeout"))
		active := h.expectActive(KindTor)
		if active.Since.Sub(epoch) != 30*time.Second {
			t.Fatalf("fallback active since %s, want at the failure", active.Since.Sub(epoch))
		}

		// The last attempt was the first punch at 0 s, so the next one waits
		// for the 5 min interval, which also covers the 2 min hysteresis.
		h.clock.AdvanceTo(5*time.Minute - time.Millisecond)
		if punches := h.puncher.callTimes(); len(punches) != 1 {
			t.Fatalf("punches at %v before the interval", punches)
		}
		h.clock.AdvanceTo(5 * time.Minute)
		if punches := h.puncher.callTimes(); !slices.Equal(punches, []time.Duration{0, 5 * time.Minute}) {
			t.Fatalf("punches at %v", punches)
		}
	})
}

func TestOscillatingDirectPathNeverImprovesWithinHysteresis(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutPuncher(), withCard(pairing.Candidate{Type: pairing.CandidateSTUN, Address: stunAddress}))
		h.direct.set(stunAddress, modeAnswer)
		h.direct.life = 10 * time.Second
		h.mustConnect(KindDirect)
		h.clock.Advance(30 * time.Minute)

		var attempts []time.Duration
		for _, call := range h.direct.callList() {
			attempts = append(attempts, call.at)
		}
		want := []time.Duration{0}
		for at := 2*time.Minute + 10*time.Second; at < 30*time.Minute; at += 5 * time.Minute {
			want = append(want, at)
		}
		if !slices.Equal(attempts, want) {
			t.Fatalf("direct attempts at %v, want %v", attempts, want)
		}

		events := h.events.pathList()
		for i := 1; i < len(attempts); i++ {
			var lastSwitch time.Duration
			for _, event := range events {
				if event.at < attempts[i] {
					lastSwitch = event.at
				}
			}
			if attempts[i]-lastSwitch < DefaultHysteresis {
				t.Fatalf("improvement at %s only %s after the switch at %s", attempts[i], attempts[i]-lastSwitch, lastSwitch)
			}
			if i > 1 && attempts[i]-attempts[i-1] < DefaultUpgradeInterval {
				t.Fatalf("improvements at %s and %s are closer than the interval", attempts[i-1], attempts[i])
			}
		}
		for i := 1; i < len(events); i++ {
			if events[i].event.Path == KindDirect && events[i].event.Reason != ReasonUpgrade {
				t.Fatalf("direct adopted for %q", events[i].event.Reason)
			}
		}
	})
}

// TestNetworkChangesKeepTheReserveWithinHysteresis is CONN-06: the phone
// reports a network change every 10 s, as NetInfo does during a handoff, and
// the reserve is re-dialed each time but only left for a direct path when the
// stability rules allow an improvement, the same schedule as the oscillating
// direct path above.
func TestNetworkChangesKeepTheReserveWithinHysteresis(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutPuncher(), withCard(pairing.Candidate{Type: pairing.CandidateSTUN, Address: stunAddress}))
		h.direct.set(stunAddress, modeAnswer)
		h.direct.life = 10 * time.Second
		h.direct.migrate = func(context.Context) error { return nil }
		h.mustConnect(KindDirect)
		torDials := h.tor.dialCount()
		changes := 0
		for h.clock.Elapsed() < 30*time.Minute {
			h.clock.Advance(5 * time.Second)
			if h.clock.Elapsed()%(10*time.Second) != 5*time.Second {
				continue
			}
			h.manager.NotifyNetworkChange(true)
			synctest.Wait()
			changes++
		}

		var attempts []time.Duration
		for _, call := range h.direct.callList() {
			attempts = append(attempts, call.at)
		}
		want := []time.Duration{0}
		for at := 2*time.Minute + 10*time.Second; at < 30*time.Minute; at += 5 * time.Minute {
			want = append(want, at)
		}
		if !slices.Equal(attempts, want) {
			t.Fatalf("direct attempts at %v, want %v despite %d network changes", attempts, want, changes)
		}
		events := h.events.pathList()
		for i := 1; i < len(attempts); i++ {
			var lastSwitch time.Duration
			for _, event := range events {
				if event.at < attempts[i] {
					lastSwitch = event.at
				}
			}
			if attempts[i]-lastSwitch < DefaultHysteresis {
				t.Fatalf("network change left the reserve at %s, only %s after the switch at %s", attempts[i], attempts[i]-lastSwitch, lastSwitch)
			}
		}
		// Every change with the reserve active re-dialed it and kept it.
		if h.tor.dialCount() < torDials+changes/2 {
			t.Fatalf("tor dials %d after %d network changes, want the reserve re-dialed", h.tor.dialCount()-torDials, changes)
		}
		for i := 1; i < len(events); i++ {
			if events[i].event.Path == KindTor && events[i].event.Reason != ReasonPathFailed {
				t.Fatalf("reserve adopted again for %q: a kept reserve emits nothing", events[i].event.Reason)
			}
		}
		if status := h.manager.Status(); status.State != StateConnected || status.Active == nil || status.Active.Kind != KindTor {
			t.Fatalf("status = %+v", status)
		}
	})
}

// TestAdoptingAnEquivalentPathKeepsItAndEmitsNoEvent is the manager half of
// CONN-05: an evaluation that dials the endpoint of the active path again
// replaces the session underneath but keeps the path, Since included, resets
// no hysteresis and emits nothing, so the proxy closes no upstream. A path of
// another kind is still a switch.
func TestAdoptingAnEquivalentPathKeepsItAndEmitsNoEvent(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutTor(), withoutPuncher())
		h.direct.set(lanAddress, modeAnswer)
		h.mustConnect(KindLAN)
		before := h.manager.Active()
		old := h.direct.session(0)
		h.clock.Advance(time.Minute)

		// An evaluation without migration dials the same local candidate
		// while the path is still active.
		h.manager.mu.Lock()
		h.manager.startRunLocked(ReasonNetworkChanged, plan{lan: true})
		h.manager.mu.Unlock()
		synctest.Wait()

		fresh := h.direct.session(-1)
		if fresh == old || !old.ended() || fresh.ended() {
			t.Fatal("the new session must replace the old one underneath the path")
		}
		if after := h.manager.Active(); after != before {
			t.Fatalf("equivalent adopt changed the path: %+v to %+v", before, after)
		}
		if events := h.events.pathList(); len(events) != 1 {
			t.Fatalf("equivalent adopt emitted events: %+v", events)
		}
		h.manager.mu.Lock()
		switched := h.manager.lastSwitchAt
		h.manager.mu.Unlock()
		if !switched.IsZero() {
			t.Fatalf("equivalent adopt counted as a switch at %s", switched.Sub(epoch))
		}
		if status := h.manager.Status(); status.State != StateConnected {
			t.Fatalf("status = %+v", status)
		}

		h.direct.set(lanAddress, modeRefuse)
		h.direct.set(stunAddress, modeAnswer)
		h.manager.mu.Lock()
		h.manager.startRunLocked(ReasonNetworkChanged, plan{internet: true})
		h.manager.mu.Unlock()
		synctest.Wait()
		if active := h.manager.Active(); active.Kind != KindDirect || active.Since.Sub(epoch) != time.Minute {
			t.Fatalf("active = %+v, want the internet path adopted now", active)
		}
		if events := h.events.pathList(); len(events) != 2 || events[1].event.Path != KindDirect || events[1].at != time.Minute {
			t.Fatalf("events = %+v, want the switch to the internet path", events)
		}
	})
}

func TestImprovementAttemptsFromTheFallback(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.mustConnect(KindTor)

		h.clock.AdvanceTo(16 * time.Minute)
		every5 := []time.Duration{0, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute}
		if punches := h.puncher.callTimes(); !slices.Equal(punches, every5) {
			t.Fatalf("punches at %v, want %v", punches, every5)
		}
		torDials := h.tor.dialCount()

		// Background pauses the attempts.
		h.manager.NotifyForeground(false)
		h.clock.AdvanceTo(22 * time.Minute)
		if punches := h.puncher.callTimes(); len(punches) != 4 {
			t.Fatalf("punches in the background: %v", punches)
		}

		// Foreground re-dials the fallback and, since an attempt is due, runs
		// the direct steps and the punch.
		lanDials := len(h.direct.callList())
		h.manager.NotifyForeground(true)
		synctest.Wait()
		if h.tor.dialCount() != torDials+1 || len(h.direct.callList()) != lanDials+2 || len(h.puncher.callTimes()) != 5 {
			t.Fatalf("foreground: tor %d→%d, direct %d→%d, punches %v",
				torDials, h.tor.dialCount(), lanDials, len(h.direct.callList()), h.puncher.callTimes())
		}
		h.expectActive(KindTor)

		// A second foreground within the interval only re-dials the fallback.
		h.manager.NotifyForeground(false)
		h.clock.Advance(time.Minute)
		h.manager.NotifyForeground(true)
		synctest.Wait()
		if h.tor.dialCount() != torDials+2 || len(h.direct.callList()) != lanDials+2 || len(h.puncher.callTimes()) != 5 {
			t.Fatalf("second foreground: tor %d, direct %d, punches %v", h.tor.dialCount(), len(h.direct.callList()), h.puncher.callTimes())
		}
		if len(h.events.pathList()) != 1 {
			t.Fatalf("keeping the fallback must not emit events: %+v", h.events.pathList())
		}
	})
}

func TestForegroundDropsAFallbackThatNoLongerAnswers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutPuncher())
		h.mustConnect(KindTor)
		h.manager.NotifyForeground(false)
		h.tor.setDialErr(errors.New("circuit closed"))
		h.clock.Advance(time.Minute)
		h.manager.NotifyForeground(true)
		h.clock.Advance(DefaultTorBudget)
		if status := h.manager.Status(); status.State != StateOffline || status.Error != CodeNoPath || status.Active != nil {
			t.Fatalf("status = %+v", status)
		}
	})
}

func TestNetworkChangeDuringAttemptRestartsTheEvaluation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeHang)
		h.direct.set(stunAddress, modeHang)
		outcome := h.connect()
		h.clock.Advance(time.Second)

		h.direct.set(lanAddress, modeAnswer)
		h.manager.NotifyNetworkChange(true)
		result := h.await(outcome, time.Minute)
		if result.err != nil || result.result.Path != KindLAN || result.at != time.Second {
			t.Fatalf("Connect = %+v", result)
		}
		calls := h.direct.callList()
		if len(calls) != 4 || !errors.Is(calls[0].err, context.Canceled) || !errors.Is(calls[1].err, context.Canceled) {
			t.Fatalf("calls = %+v, want the first evaluation cancelled", calls)
		}
		if last := h.lastEvent().event; last.Reason != ReasonNetworkChanged {
			t.Fatalf("event = %+v", last)
		}
		if h.tor.dialCount() != 0 {
			t.Fatal("the cancelled evaluation must not reach the fallback")
		}
	})
}

func TestUnreachableNetworkStopsAttemptsUntilItComesBack(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeHang)
		h.direct.set(stunAddress, modeHang)
		outcome := h.connect()
		h.clock.Advance(time.Second)

		h.manager.NotifyNetworkChange(false)
		result := h.await(outcome, time.Second)
		if Code(result.err) != CodeNoPath || !errors.Is(result.err, errNetworkUnreachable) {
			t.Fatalf("Connect = %v", result.err)
		}
		h.clock.Advance(10 * time.Minute)
		if calls := len(h.direct.callList()); calls != 2 || h.tor.dialCount() != 0 {
			t.Fatalf("attempts while unreachable: direct %d, tor %d", calls, h.tor.dialCount())
		}

		h.direct.set(lanAddress, modeAnswer)
		h.manager.NotifyNetworkChange(true)
		h.expectActive(KindLAN)
	})
}

func TestNetworkChangeMigratesTheDirectSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeAnswer)
		h.direct.migrate = func(context.Context) error { return nil }
		h.mustConnect(KindLAN)
		before := h.manager.Active()
		dials := len(h.direct.callList())

		h.clock.Advance(time.Minute)
		h.manager.NotifyNetworkChange(true)
		synctest.Wait()
		session := h.direct.session(0)
		sockets := h.sockets.list()
		if after := h.manager.Active(); after != before || session.ended() {
			t.Fatalf("migration replaced the path: %+v → %+v", before, after)
		}
		if migrations := session.migrationList(); len(migrations) != 1 || len(sockets) != 1 || sockets[0].isClosed() || migrations[0] != sockets[0] {
			t.Fatal("the session must own the new socket after a successful migration")
		}
		if len(h.direct.callList()) != dials || len(h.events.pathList()) != 1 || h.tor.dialCount() != 0 {
			t.Fatal("a successful migration must not dial or emit events")
		}
		if h.manager.Status().State != StateConnected {
			t.Fatalf("status = %+v", h.manager.Status())
		}
	})
}

func TestFailedMigrationReconnectsFromScratch(t *testing.T) {
	cases := []struct {
		name    string
		migrate func(context.Context) error
		wait    time.Duration
	}{
		{name: "path validation fails", migrate: func(context.Context) error { return errors.New("no path response") }},
		{name: "path validation exceeds its budget", migrate: func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		}, wait: DefaultMigrateBudget},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				h := newHarness(t)
				h.direct.set(lanAddress, modeAnswer)
				h.direct.migrate = tc.migrate
				h.mustConnect(KindLAN)
				old := h.direct.session(0)

				h.manager.NotifyNetworkChange(true)
				h.clock.Advance(tc.wait)
				fresh := h.direct.session(-1)
				if fresh == old || !old.ended() || fresh.ended() {
					t.Fatal("a failed migration must close the session and dial a new one")
				}
				if sockets := h.sockets.list(); len(sockets) != 1 || !sockets[0].isClosed() {
					t.Fatal("the socket of a failed migration must be closed")
				}
				last := h.lastEvent()
				if last.event.Path != KindLAN || last.event.Reason != ReasonNetworkChanged || last.at != tc.wait {
					t.Fatalf("last event = %+v", last)
				}
			})
		})
	}
}

func TestRevocationEndsWithoutRetrying(t *testing.T) {
	revokedByBridge := fmt.Errorf("bridge closed with 4401: %w", ErrRevoked)
	cases := []struct {
		name   string
		revoke func(*harness)
	}{
		{name: "direct dial refused as revoked", revoke: func(h *harness) {
			h.direct.set(lanAddress, modeRevoked)
			outcome := h.await(h.connect(), time.Second)
			if Code(outcome.err) != CodeRevoked || !errors.Is(outcome.err, ErrRevoked) {
				h.t.Fatalf("Connect = %v", outcome.err)
			}
		}},
		{name: "active direct session closed as revoked", revoke: func(h *harness) {
			h.direct.set(lanAddress, modeAnswer)
			h.mustConnect(KindLAN)
			h.direct.session(0).end(fmt.Errorf("%w: application error 0x105", transport.ErrRevoked))
		}},
		{name: "bridge reports 4401 over the fallback", revoke: func(h *harness) {
			h.mustConnect(KindTor)
			h.manager.ReportFailure(revokedByBridge)
		}},
		{name: "punch refused as revoked", revoke: func(h *harness) {
			h.puncher.err = transport.ErrRevoked
			h.await(h.connect(), time.Second)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				h := newHarness(t)
				tc.revoke(h)
				synctest.Wait()
				status := h.manager.Status()
				if status.State != StateOffline || status.Error != CodeRevoked || status.Active != nil {
					t.Fatalf("status = %+v", status)
				}
				if last := h.lastEvent().event; last.Path != KindNone || last.Reason != CodeRevoked {
					t.Fatalf("last event = %+v", last)
				}
				dials, torDials, punches := len(h.direct.callList()), h.tor.dialCount(), len(h.puncher.callTimes())

				h.clock.Advance(30 * time.Minute)
				h.manager.NotifyNetworkChange(true)
				h.manager.NotifyForeground(true)
				h.manager.ReportFailure(errors.New("ping lost"))
				if _, err := h.manager.Connect(context.Background()); Code(err) != CodeRevoked {
					t.Fatalf("Connect after revocation = %v", err)
				}
				if _, err := h.manager.DialContext(context.Background(), "tcp", ""); !errors.Is(err, ErrRevoked) {
					t.Fatalf("DialContext after revocation = %v", err)
				}
				synctest.Wait()
				if len(h.direct.callList()) != dials || h.tor.dialCount() != torDials || len(h.puncher.callTimes()) != punches {
					t.Fatal("revocation must stop every attempt")
				}
				for _, session := range h.direct.sessionList() {
					if !session.ended() {
						t.Fatal("revocation must close the direct sessions")
					}
				}
			})
		})
	}
}

func TestDialContextFollowsTheActivePath(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutPuncher())
		h.direct.set(lanAddress, modeAnswer)
		ctx := context.Background()

		// The first dial connects lazily.
		conn, err := h.manager.DialContext(ctx, "tcp", "cialai-desktop:47400")
		if err != nil {
			t.Fatal(err)
		}
		if stream, ok := conn.(*fakeStream); !ok || stream.session != h.direct.session(0) {
			t.Fatalf("stream = %T", conn)
		}
		_ = conn.Close()

		// A stream that cannot open fails the direct path; the same call
		// returns a connection over the fallback.
		h.direct.set(lanAddress, modeRefuse)
		h.direct.session(0).end(errors.New("stream limit"))
		conn, err = h.manager.DialContext(ctx, "tcp", "")
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := conn.(*tls.Conn); !ok {
			t.Fatalf("conn = %T, want an onion connection", conn)
		}
		_ = conn.Close()
		h.expectActive(KindTor)

		// An onion dial failure fails the fallback too, and the local path
		// that came back takes over within the same call.
		h.direct.set(lanAddress, modeAnswer)
		h.tor.setDialErr(errors.New("circuit destroyed"))
		conn, err = h.manager.DialContext(ctx, "tcp", "")
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := conn.(*fakeStream); !ok {
			t.Fatalf("conn = %T, want a direct stream", conn)
		}
		_ = conn.Close()
		h.expectActive(KindLAN)

		if _, err := h.manager.DialContext(ctx, "udp", ""); err == nil {
			t.Fatal("datagram networks must be refused")
		}
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		h.direct.set(lanAddress, modeHang)
		h.direct.set(stunAddress, modeHang)
		h.direct.session(-1).end(errors.New("gone"))
		synctest.Wait()
		if _, err := h.manager.DialContext(cancelled, "tcp", ""); !errors.Is(err, context.Canceled) {
			t.Fatalf("DialContext with a cancelled context = %v", err)
		}
	})
}

func TestReportFailureReplacesTheActivePath(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutPuncher())
		h.mustConnect(KindTor)
		h.clock.Advance(time.Minute)
		h.manager.ReportFailure(errors.New("three bridge pings lost"))
		h.clock.Advance(DefaultDirectBudget)
		h.expectActive(KindTor)
		if h.tor.dialCount() != 2 {
			t.Fatalf("tor dials = %d, want the fallback probed again", h.tor.dialCount())
		}
		if last := h.lastEvent(); last.event.Reason != ReasonPathFailed || last.at != time.Minute {
			t.Fatalf("last event = %+v", last)
		}
		h.manager.ReportFailure(nil)
		synctest.Wait()
		if h.manager.Status().State != StateConnected {
			t.Fatalf("status = %+v", h.manager.Status())
		}
	})
}

func TestStateTransitionsAndStatusJSON(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutPuncher())
		if status := h.manager.Status(); status.State != StateIdle || status.Active != nil {
			t.Fatalf("new manager status = %+v", status)
		}
		h.direct.set(lanAddress, modeHang)
		outcome := h.connect()
		if h.manager.Status().State != StateConnecting {
			t.Fatalf("status = %+v", h.manager.Status())
		}
		h.await(outcome, time.Minute)
		status := h.manager.Status()
		raw, err := json.Marshal(status)
		if err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{`"state":"connected"`, `"transport":"tor"`, `"path":"tor"`, `"desktopId":"` + h.card.Desktop.ID + `"`, `"since":`, `"progress":100`} {
			if !strings.Contains(string(raw), field) {
				t.Fatalf("status JSON %s lacks %s", raw, field)
			}
		}
		event, err := json.Marshal(h.lastEvent().event)
		if err != nil {
			t.Fatal(err)
		}
		if want := `{"desktopId":"` + h.card.Desktop.ID + `","transport":"tor","path":"tor","reason":"connect"}`; string(event) != want {
			t.Fatalf("event JSON = %s, want %s", event, want)
		}
	})
}

func TestReportedAndExpiredCandidates(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, withoutTor())
		h.direct.set(reportedLocal, modeAnswer)
		h.manager.SetReportedLAN([]netip.AddrPort{
			netip.MustParseAddrPort("[::ffff:192.168.1.11]:4740"),
			netip.MustParseAddrPort(reportedLocal),
			netip.MustParseAddrPort("0.0.0.0:4740"),
			{},
		})
		h.clock.Advance(2 * time.Hour) // past the one hour card
		result := h.mustConnect(KindLAN)
		if result.ElapsedMillis != 0 {
			t.Fatalf("result = %+v", result)
		}
		calls := h.direct.callList()
		if len(calls) != 1 || len(calls[0].candidates) != 1 || calls[0].candidates[0].String() != reportedLocal {
			t.Fatalf("calls = %+v, want only the reported local candidate of an expired card", calls)
		}

		renewed := testCard(t, h.desktop, pairing.Candidate{Type: pairing.CandidateIPv6, Address: "[2001:db8::7]:4740"})
		renewed.IssuedAt, renewed.ExpiresAt = epoch.Add(2*time.Hour), epoch.Add(3*time.Hour)
		if err := h.manager.UpdateCard(renewed); err != nil {
			t.Fatal(err)
		}
		if other := testCard(t, mustIdentity(t, identity.RoleDesktop)); h.manager.UpdateCard(other) == nil {
			t.Fatal("a card of another desktop must be refused")
		}
		if err := h.manager.UpdateCard(candidates.Card{}); err == nil {
			t.Fatal("an invalid card must be refused")
		}
		h.manager.SetReportedLAN(nil)
		h.direct.session(0).end(errors.New("gone"))
		synctest.Wait()
		calls = h.direct.callList()
		if last := calls[len(calls)-1]; len(last.candidates) != 1 || last.candidates[0].String() != "[2001:db8::7]:4740" {
			t.Fatalf("last dial = %+v, want the renewed internet candidate", last)
		}
	})
}

func TestCloseStopsEverything(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeHang)
		h.direct.set(stunAddress, modeHang)
		outcome := h.connect()
		if err := h.manager.Close(); err != nil {
			t.Fatal(err)
		}
		if result := <-outcome; !errors.Is(result.err, ErrClosed) {
			t.Fatalf("Connect = %v", result.err)
		}
		if _, err := h.manager.DialContext(context.Background(), "tcp", ""); !errors.Is(err, ErrClosed) {
			t.Fatalf("DialContext = %v", err)
		}
		h.manager.NotifyNetworkChange(true)
		h.manager.NotifyForeground(true)
		h.manager.ReportFailure(ErrRevoked)
		h.clock.Advance(time.Hour)
		if len(h.direct.callList()) != 2 || h.tor.dialCount() != 0 {
			t.Fatal("a closed manager must not dial")
		}
		if err := h.manager.Close(); err != nil {
			t.Fatal(err)
		}

		h2 := newHarness(t)
		h2.direct.set(lanAddress, modeAnswer)
		h2.mustConnect(KindLAN)
		_ = h2.manager.Close()
		if !h2.direct.session(0).ended() {
			t.Fatal("Close must close the active session")
		}
	})
}

func TestNewValidatesConfig(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		valid := Config{Card: h.card, Local: h.phone, Direct: h.direct, Tor: h.tor}
		cases := map[string]func(*Config){
			"invalid card":       func(config *Config) { config.Card = candidates.Card{} },
			"no dialer":          func(config *Config) { config.Direct, config.Tor = nil, nil },
			"tor without phone":  func(config *Config) { config.Local = nil },
			"card without onion": func(config *Config) { config.Card.Onion = "" },
		}
		for name, mutate := range cases {
			config := valid
			mutate(&config)
			if manager, err := New(config); err == nil {
				_ = manager.Close()
				t.Fatalf("%s: New accepted the config", name)
			}
		}
		manager, err := New(Config{Card: h.card, Direct: h.direct})
		if err != nil {
			t.Fatal(err)
		}
		if manager.Status().Tor.State != TorDisabled {
			t.Fatalf("status = %+v", manager.Status())
		}
		_ = manager.Close()
	})
}

func TestErrorCodes(t *testing.T) {
	cause := errors.New("socks failure")
	for _, tc := range []struct {
		err      error
		code     string
		sentinel error
	}{
		{newError(CodeNoPath, cause), CodeNoPath, ErrNoPath},
		{newError(CodeReservePreparing, nil), CodeReservePreparing, ErrReservePreparing},
		{newError(CodeReserveUnavailable, cause), CodeReserveUnavailable, ErrReserveUnavailable},
		{newError(CodeRevoked, errors.New("bridge closed with 4401")), CodeRevoked, transport.ErrRevoked},
		{fmt.Errorf("session: %w", transport.ErrRevoked), CodeRevoked, ErrRevoked},
	} {
		if Code(tc.err) != tc.code || !errors.Is(tc.err, tc.sentinel) || tc.err.Error() == "" {
			t.Fatalf("%v: code %q, is sentinel %v", tc.err, Code(tc.err), errors.Is(tc.err, tc.sentinel))
		}
	}
	if !errors.Is(newError(CodeNoPath, cause), cause) || Code(cause) != "" {
		t.Fatal("the cause must stay reachable and plain errors have no code")
	}
}

func TestConcurrentUseKeepsAtMostOneDirectSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t)
		h.direct.set(lanAddress, modeAnswer)
		h.direct.set(stunAddress, modeAnswer)
		h.direct.life = 3 * time.Second
		h.direct.migrate = func(context.Context) error { return errors.New("no path response") }
		h.puncher.set(netip.MustParseAddrPort(punchAddress), nil)
		h.mustConnect(KindLAN)

		stop, cancel := context.WithCancel(context.Background())
		var workers sync.WaitGroup
		for worker := range 6 {
			workers.Go(func() {
				for step := 0; stop.Err() == nil; step++ {
					switch (worker + step) % 6 {
					case 0:
						ctx, done := withBudget(h.clock, stop, time.Second)
						if conn, err := h.manager.DialContext(ctx, "tcp", ""); err == nil {
							_ = conn.Close()
						}
						done()
					case 1:
						h.manager.ReportFailure(errors.New("three bridge pings lost"))
					case 2:
						h.manager.NotifyNetworkChange(step%4 != 0)
					case 3:
						h.manager.NotifyForeground(step%3 != 0)
					case 4:
						_, _ = h.manager.Status(), h.manager.Active()
					case 5:
						h.manager.SetReportedLAN([]netip.AddrPort{netip.MustParseAddrPort(reportedLocal)})
					}
					sleep(h.clock, stop, 250*time.Millisecond)
				}
			})
		}
		for range 2400 {
			h.clock.Advance(50 * time.Millisecond)
		}
		cancel()
		workers.Wait()
		h.manager.NotifyNetworkChange(true)
		h.clock.Advance(time.Minute)

		live := 0
		for _, session := range append(h.direct.sessionList(), h.puncher.sessionList()...) {
			if !session.ended() {
				live++
			}
		}
		active := h.manager.Active()
		want := 0
		if active.Transport == transport.NameDirect {
			want = 1
		}
		if live != want {
			t.Fatalf("%d live direct sessions with active path %+v", live, active)
		}
		t.Logf("%d direct dials, %d punched sessions, %d onion dials, %d path events",
			len(h.direct.callList()), len(h.puncher.sessionList()), h.tor.dialCount(), len(h.events.pathList()))
		if err := h.manager.Close(); err != nil {
			t.Fatal(err)
		}
		for _, session := range append(h.direct.sessionList(), h.puncher.sessionList()...) {
			if !session.ended() {
				t.Fatal("Close left a direct session open")
			}
		}
	})
}
