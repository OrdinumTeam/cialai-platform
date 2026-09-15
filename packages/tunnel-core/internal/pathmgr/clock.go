// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"time"
)

// Clock is the time source of every budget and stability rule, so tests can
// replace it with a fake clock.
type Clock interface {
	Now() time.Time
	// AfterFunc calls f in its own goroutine once d has elapsed.
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a pending AfterFunc call.
type Timer interface {
	// Stop prevents the call and reports whether it was still pending.
	Stop() bool
}

type systemClock struct{}

// SystemClock is the wall clock, the default of Config.Clock.
func SystemClock() Clock { return systemClock{} }

func (systemClock) Now() time.Time { return time.Now() }

func (systemClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// withBudget bounds parent by budget on clock. The wall clock gives the context
// a real deadline, which network dialers honor directly; any other clock
// cancels it from a timer.
func withBudget(clock Clock, parent context.Context, budget time.Duration) (context.Context, context.CancelFunc) {
	if _, wall := clock.(systemClock); wall {
		return context.WithTimeout(parent, budget)
	}
	ctx, cancel := context.WithCancelCause(parent)
	timer := clock.AfterFunc(budget, func() { cancel(context.DeadlineExceeded) })
	return ctx, func() {
		timer.Stop()
		cancel(context.Canceled)
	}
}

// sleep waits d on clock and reports false when ctx ended first.
func sleep(clock Clock, ctx context.Context, d time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	wake := make(chan struct{})
	timer := clock.AfterFunc(d, func() { close(wake) })
	select {
	case <-wake:
		return true
	case <-ctx.Done():
		timer.Stop()
		return false
	}
}
