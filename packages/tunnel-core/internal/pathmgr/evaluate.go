// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// failures collects why each step of a run did not give a path.
type failures struct {
	direct error
	tor    error
	punch  error
}

// execute runs the steps of one evaluation. Every change of the active path
// goes through adopt, keepOrAdoptTor or dropKept, which ignore a run that was
// superseded, so a cancelled run only cleans up after itself.
func (m *Manager) execute(current *run) {
	defer m.wait.Done()
	defer current.cancel()

	if current.plan.migrate {
		migrated, err := m.migrate(current)
		switch {
		case migrated:
			m.finish(current, nil)
			return
		case isRevoked(err):
			m.revoke(err)
			return
		case !m.dropKept(current):
			return
		}
	}

	var failed failures
	if current.plan.direct() {
		session, kind, err := m.dialDirect(current)
		if session != nil {
			if !m.adopt(current, kind, session, current.reason) {
				_ = session.Close()
				return
			}
			m.finish(current, nil)
			return
		}
		if isRevoked(err) {
			m.revoke(err)
			return
		}
		failed.direct = err
	}

	if current.plan.tor && current.ctx.Err() == nil {
		if err := m.reachTor(current); err != nil {
			failed.tor = err
			if !m.dropKept(current) {
				return
			}
		} else if !m.keepOrAdoptTor(current) {
			return
		}
	}

	if current.plan.punch && current.ctx.Err() == nil && m.claimPunch(current) {
		session, err := m.punch(current)
		if session != nil {
			if !m.adopt(current, KindDirect, session, ReasonPunch) {
				_ = session.Close()
				return
			}
			m.finish(current, nil)
			return
		}
		if isRevoked(err) {
			m.revoke(err)
			return
		}
		failed.punch = err
	}
	m.finish(current, m.failureError(failed))
}

// failureError picks the phone API code of a run that found no path.
func (m *Manager) failureError(failed failures) error {
	cause := errors.Join(failed.direct, failed.punch)
	var coded *Error
	switch {
	case errors.As(failed.tor, &coded):
		return newError(coded.Code, errors.Join(failed.direct, coded.Cause, failed.punch))
	case m.config.Tor == nil:
		return newError(CodeReserveUnavailable, errors.Join(errNoTor, cause))
	default:
		return newError(CodeNoPath, cause)
	}
}

// migrate moves the direct session the run started with to a new socket.
func (m *Manager) migrate(current *run) (bool, error) {
	session := current.kept.session
	migrator, ok := session.(Migrator)
	if !ok {
		return false, errMigrationless
	}
	packetConn, err := m.config.ListenPacket()
	if err != nil {
		return false, fmt.Errorf("open migration socket: %w", err)
	}
	ctx, cancel := withBudget(m.clock, current.ctx, m.timings.Migrate)
	err = migrator.Migrate(ctx, packetConn)
	cancel()
	if err != nil {
		_ = packetConn.Close()
		m.config.Logf("pathmgr: migration of %s failed: %v", current.kept.path.Address, err)
		return false, err
	}
	m.config.Logf("pathmgr: migrated %s to %s", current.kept.path.Address, packetConn.LocalAddr())
	return true, nil
}

// dialDirect runs steps 1 and 2 in parallel. A local session wins: when the
// internet dial answers first, the local one still gets the rest of its
// budget.
func (m *Manager) dialDirect(current *run) (transport.Session, Kind, error) {
	lan, internet := m.directCandidates(current.plan)
	if len(lan) == 0 && len(internet) == 0 {
		return nil, "", transport.ErrNoCandidates
	}
	key := m.currentDesktop().PublicKey
	steps, stop := context.WithCancel(current.ctx)
	defer stop()

	type outcome struct {
		kind    Kind
		session transport.Session
		err     error
	}
	results := make(chan outcome, 2)
	pending := 0
	launch := func(kind Kind, list []netip.AddrPort, budget time.Duration) {
		if len(list) == 0 {
			return
		}
		pending++
		go func() {
			ctx, cancel := withBudget(m.clock, steps, budget)
			defer cancel()
			session, err := m.config.Direct.DialCandidates(ctx, list, key)
			if err != nil {
				if session != nil {
					_ = session.Close()
				}
				session = nil
			}
			results <- outcome{kind: kind, session: session, err: err}
		}()
	}
	launch(KindLAN, lan, m.timings.LAN)
	launch(KindDirect, internet, m.timings.Direct)

	var local, remote transport.Session
	var errs []error
	for range pending {
		result := <-results
		switch {
		case result.err != nil:
			errs = append(errs, fmt.Errorf("%s candidates: %w", result.kind, result.err))
		case result.kind == KindLAN:
			local = result.session
			stop()
		default:
			remote = result.session
		}
	}
	switch {
	case local != nil:
		if remote != nil {
			_ = remote.Close()
		}
		return local, KindLAN, nil
	case remote != nil:
		return remote, KindDirect, nil
	}
	return nil, "", errors.Join(errs...)
}

// reachTor runs step 3: it follows the bootstrap, then dials the onion until
// one connection completes the pinned handshake or the budget ends. The probe
// connection is closed; the edge streams open their own.
func (m *Manager) reachTor(current *run) error {
	ctx, cancel := withBudget(m.clock, current.ctx, m.timings.Tor)
	defer cancel()
	desktop := m.currentDesktop()
	progress := -1
	var statusErr, dialErr error
	for {
		status, err := m.config.Tor.Bootstrap(ctx)
		switch {
		case errors.Is(err, tor.ErrNoEndpoints):
			m.setTor(TorStatus{State: TorDisabled})
			return newError(CodeReserveUnavailable, err)
		case err == nil && status.Progress < 100:
			progress, statusErr = status.Progress, nil
			m.setTor(TorStatus{State: TorBootstrapping, Progress: status.Progress})
			if !sleep(m.clock, ctx, m.timings.TorPoll) {
				return m.torGaveUp(progress, statusErr, dialErr)
			}
			continue
		case err == nil:
			progress, statusErr = 100, nil
			m.setTor(TorStatus{State: TorReady, Progress: 100})
		case errors.Is(err, tor.ErrNoControlEndpoint):
			// Without a control port only the dial tells whether Tor works.
		case ctx.Err() != nil:
			return m.torGaveUp(progress, statusErr, dialErr)
		default:
			statusErr = err
		}

		conn, err := m.config.Tor.DialTLS(ctx, desktop.Onion, m.config.Local, desktop.PublicKey)
		if err == nil {
			_ = conn.Close()
			m.setTor(TorStatus{State: TorReady, Progress: 100})
			return nil
		}
		switch {
		case errors.Is(err, tor.ErrNoEndpoints):
			m.setTor(TorStatus{State: TorDisabled})
			return newError(CodeReserveUnavailable, err)
		case progress < 0 && socksUnreachable(err) && ctx.Err() == nil:
			// Tor gave no status and does not listen: it is not running.
			m.setTor(TorStatus{State: TorFailed})
			return newError(CodeReserveUnavailable, errors.Join(statusErr, err))
		}
		dialErr = err
		m.config.Logf("pathmgr: onion dial for %s failed: %v", desktop.ID, err)
		if !sleep(m.clock, ctx, m.timings.TorRetry) {
			return m.torGaveUp(progress, statusErr, dialErr)
		}
	}
}

// torGaveUp classifies a fallback that did not answer within its budget.
func (m *Manager) torGaveUp(progress int, statusErr, dialErr error) error {
	cause := errors.Join(statusErr, dialErr)
	if cause == nil {
		cause = context.DeadlineExceeded
	}
	switch {
	case progress >= 0 && progress < 100:
		return newError(CodeReservePreparing, cause)
	case progress < 0 && statusErr != nil:
		m.setTor(TorStatus{State: TorFailed})
		return newError(CodeReserveUnavailable, cause)
	default:
		return newError(CodeNoPath, cause)
	}
}

// punch runs step 4 within its budget.
func (m *Manager) punch(current *run) (transport.Session, error) {
	ctx, cancel := withBudget(m.clock, current.ctx, m.timings.Punch)
	defer cancel()
	session, err := m.config.Puncher.Punch(ctx, m.currentDesktop())
	if err != nil {
		if session != nil {
			_ = session.Close()
		}
		return nil, err
	}
	return session, nil
}

// socksUnreachable reports whether err came from reaching the Tor SOCKS
// listener itself, which the SOCKS dialer wraps in a net.OpError whose
// cause is the failed "dial" of the proxy.
func socksUnreachable(err error) bool {
	for err != nil {
		var operation *net.OpError
		if !errors.As(err, &operation) {
			return false
		}
		if operation.Op == "dial" {
			return true
		}
		err = operation.Err
	}
	return false
}
