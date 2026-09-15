// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// Default budgets and stability timings from section 6.3 of the plan.
const (
	DefaultLANBudget       = 1500 * time.Millisecond
	DefaultDirectBudget    = 2 * time.Second
	DefaultTorBudget       = 20 * time.Second
	DefaultPunchBudget     = 5 * time.Second
	DefaultMigrateBudget   = 2 * time.Second
	DefaultTorPoll         = time.Second
	DefaultTorRetry        = 5 * time.Second
	DefaultHysteresis      = 2 * time.Minute
	DefaultUpgradeInterval = 5 * time.Minute
	// MaxReportedLAN bounds the candidates kept from native discovery.
	MaxReportedLAN = 16
	// maxDialFailures bounds the paths one DialContext call gives up on.
	maxDialFailures = 3
)

// DefaultRetries returns the offline retry delays of section 6.4.
func DefaultRetries() []time.Duration {
	return []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}
}

// Timings overrides budgets and stability rules; zero fields take the defaults.
type Timings struct {
	LAN     time.Duration
	Direct  time.Duration
	Tor     time.Duration
	Punch   time.Duration
	Migrate time.Duration
	// TorPoll spaces bootstrap queries while Tor bootstraps.
	TorPoll time.Duration
	// TorRetry spaces onion dials within the Tor budget.
	TorRetry time.Duration
	// Hysteresis is the quiet time after a switch before improving a path.
	Hysteresis time.Duration
	// UpgradeInterval is the minimum spacing of improvement attempts.
	UpgradeInterval time.Duration
	// Retries are the delays of the evaluations after every path failed; nil
	// means DefaultRetries and an empty non-nil slice disables them.
	Retries []time.Duration
}

func (timings Timings) normalize() Timings {
	timings.LAN = orDefault(timings.LAN, DefaultLANBudget)
	timings.Direct = orDefault(timings.Direct, DefaultDirectBudget)
	timings.Tor = orDefault(timings.Tor, DefaultTorBudget)
	timings.Punch = orDefault(timings.Punch, DefaultPunchBudget)
	timings.Migrate = orDefault(timings.Migrate, DefaultMigrateBudget)
	timings.TorPoll = orDefault(timings.TorPoll, DefaultTorPoll)
	timings.TorRetry = orDefault(timings.TorRetry, DefaultTorRetry)
	timings.Hysteresis = orDefault(timings.Hysteresis, DefaultHysteresis)
	timings.UpgradeInterval = orDefault(timings.UpgradeInterval, DefaultUpgradeInterval)
	if timings.Retries == nil {
		timings.Retries = DefaultRetries()
	} else {
		timings.Retries = slices.Clone(timings.Retries)
	}
	return timings
}

// Config describes the manager of one desktop.
type Config struct {
	// Card is the reach card of the desktop: pinned key, onion and memorized
	// candidates. UpdateCard renews it.
	Card candidates.Card
	// Local is the phone identity, required to dial the fallback.
	Local *identity.Identity
	// Direct dials steps 1 and 2; nil skips them.
	Direct DirectDialer
	// Tor dials step 3; nil makes the fallback unavailable.
	Tor TorDialer
	// Puncher runs step 4; nil skips it.
	Puncher Puncher
	// ListenPacket opens the socket a direct session migrates to after a
	// network change; nil listens on an ephemeral UDP port.
	ListenPacket func() (net.PacketConn, error)
	// Clock defaults to SystemClock.
	Clock   Clock
	Timings Timings
	// OnPath receives EventPathChanged payloads and OnTor the fallback state.
	// OnCard receives each reach card adopted by UpdateCard, including the
	// cards the desktop renews over the control channel of a direct session,
	// so the owner can persist them. Callbacks run in order on one goroutine
	// and must not call Close.
	OnPath func(PathEvent)
	OnTor  func(TorStatus)
	OnCard func(candidates.Card)
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

// Manager keeps the path to one desktop. Its methods are safe for concurrent
// use.
type Manager struct {
	config  Config
	clock   Clock
	timings Timings
	events  *dispatcher
	wait    sync.WaitGroup

	mu            sync.Mutex
	card          candidates.Card
	desktop       Desktop
	reportedLAN   []netip.AddrPort
	state         State
	active        *activePath
	pathSeq       uint64
	hadPath       bool
	run           *run
	runSeq        uint64
	settledSeq    uint64
	lastErr       error
	lastSwitchAt  time.Time
	lastUpgradeAt time.Time
	timer         Timer
	timerSeq      uint64
	retries       int
	reachable     bool
	foreground    bool
	tor           TorStatus
	lastEvent     PathEvent
	revoked       error
	closed        bool
	changed       chan struct{}
}

type activePath struct {
	seq      uint64
	path     Path
	session  transport.Session // nil over Tor
	stop     chan struct{}
	stopOnce sync.Once
	// ctx ends when the path is released; it bounds the control channel.
	ctx    context.Context
	cancel context.CancelFunc
}

// run is one evaluation. Only the current run may change the active path.
type run struct {
	seq     uint64
	reason  string
	plan    plan
	started time.Time
	ctx     context.Context
	cancel  context.CancelFunc
	// kept is the path active when the run started, which it may keep.
	kept *activePath
	// punched is set once the run claimed a punch.
	punched bool
}

type plan struct {
	migrate  bool
	lan      bool
	internet bool
	tor      bool
	punch    bool
	// upgrade marks an improvement attempt already counted by the manager.
	upgrade bool
}

func (p plan) direct() bool { return p.lan || p.internet }

// New validates config and returns an idle manager.
func New(config Config) (*Manager, error) {
	desktop, err := desktopOf(config.Card)
	if err != nil {
		return nil, err
	}
	if config.Direct == nil && config.Tor == nil {
		return nil, errors.New("path manager needs a direct dialer or a Tor dialer")
	}
	if config.Tor != nil && config.Local == nil {
		return nil, errors.New("path manager needs the phone identity to dial the Tor fallback")
	}
	if config.Clock == nil {
		config.Clock = SystemClock()
	}
	if config.ListenPacket == nil {
		config.ListenPacket = func() (net.PacketConn, error) { return net.ListenPacket("udp", ":0") }
	}
	if config.Logf == nil {
		config.Logf = func(string, ...any) {}
	}
	manager := &Manager{
		config:     config,
		clock:      config.Clock,
		timings:    config.Timings.normalize(),
		events:     newDispatcher(),
		card:       config.Card,
		desktop:    desktop,
		state:      StateIdle,
		reachable:  true,
		foreground: true,
		tor:        TorStatus{State: TorUnknown},
		changed:    make(chan struct{}),
	}
	if config.Tor == nil {
		manager.tor.State = TorDisabled
	}
	return manager, nil
}

func desktopOf(card candidates.Card) (Desktop, error) {
	if err := card.Validate(); err != nil {
		return Desktop{}, err
	}
	public, err := identity.ParsePublicKey(card.Desktop.PublicKey)
	if err != nil {
		return Desktop{}, err
	}
	host, _, err := net.SplitHostPort(card.Onion)
	if err != nil {
		return Desktop{}, fmt.Errorf("reach card onion: %w", err)
	}
	return Desktop{ID: card.Desktop.ID, PublicKey: public, Onion: host}, nil
}

// Connect evaluates the paths when none is active and waits until one is, or
// until the evaluation fails. When ctx ends first the evaluation goes on.
func (m *Manager) Connect(ctx context.Context) (Result, error) {
	started := m.clock.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.unusableLocked(); err != nil {
		return Result{}, err
	}
	if m.active == nil && m.run == nil {
		m.retries = 0
		m.startRunLocked(ReasonConnect, m.fullPlan())
	}
	seq := m.runSeq
	for {
		if err := m.unusableLocked(); err != nil {
			return Result{}, err
		}
		if m.active != nil {
			path := m.active.path
			return Result{
				DesktopID: path.DesktopID, Transport: path.Transport, Path: path.Kind,
				ElapsedMillis: m.clock.Now().Sub(started).Milliseconds(),
			}, nil
		}
		if m.run == nil && m.settledSeq >= seq {
			return Result{}, m.lastErr
		}
		changed := m.changed
		m.mu.Unlock()
		select {
		case <-changed:
			m.mu.Lock()
		case <-ctx.Done():
			m.mu.Lock()
			return Result{}, ctx.Err()
		}
	}
}

// DialContext opens one stream to the desktop edge over the active path; the
// address is ignored. While an evaluation runs it waits for its outcome. A
// stream that fails to open counts as a failure of its path, and the call
// moves on to the next path.
func (m *Manager) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	if network != "" && !strings.HasPrefix(network, "tcp") {
		return nil, fmt.Errorf("path manager dials stream networks, not %q", network)
	}
	var failures []error
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		m.mu.Lock()
		if err := m.unusableLocked(); err != nil {
			m.mu.Unlock()
			return nil, err
		}
		active := m.active
		if active == nil {
			if m.run == nil {
				if m.state != StateIdle {
					err := m.lastErr
					m.mu.Unlock()
					return nil, err
				}
				m.startRunLocked(ReasonConnect, m.fullPlan())
			}
			changed := m.changed
			m.mu.Unlock()
			select {
			case <-changed:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		desktop := m.desktop
		m.mu.Unlock()

		conn, err := m.open(ctx, active, desktop)
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
		m.pathFailed(active.seq, err)
		failures = append(failures, fmt.Errorf("%s: %w", active.path.Kind, err))
		if len(failures) >= maxDialFailures {
			return nil, newError(CodeNoPath, errors.Join(failures...))
		}
	}
}

func (m *Manager) open(ctx context.Context, active *activePath, desktop Desktop) (net.Conn, error) {
	if active.session != nil {
		stream, err := active.session.OpenStream(ctx)
		if err != nil {
			return nil, err
		}
		return stream, nil
	}
	conn, err := m.config.Tor.DialTLS(ctx, desktop.Onion, m.config.Local, desktop.PublicKey)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// Active returns the active path, or the zero Path when there is none.
func (m *Manager) Active() Path {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == nil {
		return Path{}
	}
	return m.active.path
}

// Status returns a snapshot of the state, the active path and the fallback.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := Status{State: m.state, Tor: m.tor}
	if m.active != nil {
		path := m.active.path
		status.Active = &path
	} else if m.lastErr != nil {
		status.Error = Code(m.lastErr)
	}
	return status
}

// NotifyNetworkChange reports that the phone network changed. Unreachable
// stops the evaluations and retries and keeps the active path, which may
// survive a short outage. Reachable migrates an active direct session and
// otherwise evaluates again, cancelling an evaluation in progress.
func (m *Manager) NotifyNetworkChange(reachable bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.revoked != nil {
		return
	}
	m.reachable = reachable
	if !reachable {
		m.cancelRunLocked(newError(CodeNoPath, errNetworkUnreachable))
		m.stopTimerLocked()
		if m.active == nil && m.state != StateIdle {
			m.goOfflineLocked(newError(CodeNoPath, errNetworkUnreachable))
		}
		m.broadcastLocked()
		return
	}
	m.retries = 0
	full := m.fullPlan()
	switch {
	case m.active != nil && m.active.session != nil:
		full.migrate = true
		m.startRunLocked(ReasonNetworkChanged, full)
	case m.active != nil || m.state != StateIdle:
		m.startRunLocked(ReasonNetworkChanged, full)
	}
}

// NotifyForeground reports whether the app is in the foreground. Background
// pauses improvement attempts. Foreground evaluates again when no path is
// active and re-dials the fallback when it is in use.
func (m *Manager) NotifyForeground(active bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.revoked != nil {
		return
	}
	m.foreground = active
	if !active {
		if m.active != nil {
			m.stopTimerLocked()
		}
		return
	}
	if m.run != nil || m.state == StateIdle {
		return
	}
	switch {
	case m.active == nil:
		m.retries = 0
		m.startRunLocked(ReasonForeground, m.fullPlan())
	case m.active.path.Kind == KindTor:
		recheck := plan{tor: true, punch: true}
		if m.upgradeOpenLocked(m.clock.Now()) {
			m.lastUpgradeAt = m.clock.Now()
			recheck = m.fullPlan()
			recheck.upgrade = true
		}
		m.startRunLocked(ReasonForeground, recheck)
	}
}

// ReportFailure tells the manager that the active path failed, as the proxy
// does after three lost bridge pings. An error wrapping ErrRevoked, such as
// the 4401 close of the bridge, revokes the manager instead.
func (m *Manager) ReportFailure(err error) {
	if err == nil {
		err = errReportedFailure
	}
	if isRevoked(err) {
		m.revoke(err)
		return
	}
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active != nil {
		m.pathFailed(active.seq, err)
	}
}

// SetReportedLAN replaces the local candidates found by native discovery.
func (m *Manager) SetReportedLAN(addresses []netip.AddrPort) {
	cleaned := make([]netip.AddrPort, 0, min(len(addresses), MaxReportedLAN))
	for _, address := range addresses {
		address = netip.AddrPortFrom(address.Addr().Unmap(), address.Port())
		if len(cleaned) == MaxReportedLAN || !address.IsValid() || address.Port() == 0 ||
			address.Addr().IsUnspecified() || address.Addr().IsMulticast() || slices.Contains(cleaned, address) {
			continue
		}
		cleaned = append(cleaned, address)
	}
	m.mu.Lock()
	m.reportedLAN = cleaned
	m.mu.Unlock()
}

// UpdateCard replaces the reach card with a renewed one for the same desktop
// and hands it to Config.OnCard. Later evaluations dial its candidates.
func (m *Manager) UpdateCard(card candidates.Card) error {
	desktop, err := desktopOf(card)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if card.Desktop.PublicKey != m.card.Desktop.PublicKey {
		return errors.New("reach card belongs to another desktop")
	}
	m.card = card
	m.desktop = desktop
	if handle := m.config.OnCard; handle != nil {
		m.events.post(func() { handle(card) })
	}
	return nil
}

// Close stops every evaluation and timer, closes the active path and waits for
// the goroutines of the manager, event callbacks included.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		m.wait.Wait()
		return nil
	}
	m.closed = true
	m.cancelRunLocked(ErrClosed)
	m.stopTimerLocked()
	active := m.active
	m.active = nil
	m.lastErr = ErrClosed
	m.state = StateOffline
	m.broadcastLocked()
	m.mu.Unlock()
	m.release(active)
	m.wait.Wait()
	m.events.close()
	return nil
}

// unusableLocked returns the error of a closed or revoked manager.
func (m *Manager) unusableLocked() error {
	switch {
	case m.closed:
		return ErrClosed
	case m.revoked != nil:
		return m.revoked
	}
	return nil
}

func (m *Manager) fullPlan() plan {
	return plan{lan: true, internet: true, tor: true, punch: true}
}

// failoverPlan lists the steps after the failed one; a failed fallback runs
// every step again.
func (m *Manager) failoverPlan(failed Kind) plan {
	switch failed {
	case KindLAN:
		return plan{internet: true, tor: true, punch: true}
	case KindDirect:
		return plan{tor: true, punch: true}
	default:
		return m.fullPlan()
	}
}

// startRunLocked cancels the current evaluation and starts another one.
func (m *Manager) startRunLocked(reason string, p plan) {
	if m.closed || m.revoked != nil {
		return
	}
	if m.run != nil {
		m.run.cancel()
	}
	m.stopTimerLocked()
	p.lan = p.lan && m.config.Direct != nil
	p.internet = p.internet && m.config.Direct != nil
	p.tor = p.tor && m.config.Tor != nil
	p.punch = p.punch && m.config.Puncher != nil
	p.migrate = p.migrate && m.active != nil && m.active.session != nil
	m.runSeq++
	ctx, cancel := context.WithCancel(context.Background())
	current := &run{seq: m.runSeq, reason: reason, plan: p, started: m.clock.Now(), ctx: ctx, cancel: cancel, kept: m.active}
	m.run = current
	if m.active == nil {
		m.state = StateConnecting
	}
	m.config.Logf("pathmgr: %s evaluation %d for %s", reason, current.seq, m.desktop.ID)
	m.wait.Add(1)
	go m.execute(current)
	m.broadcastLocked()
}

// cancelRunLocked stops the current evaluation and settles it with err, so
// Connect callers waiting for it return.
func (m *Manager) cancelRunLocked(err error) {
	if m.run == nil {
		return
	}
	m.run.cancel()
	m.settledSeq = m.run.seq
	m.run = nil
	if m.active == nil {
		m.lastErr = err
	}
}

// adopt makes session, or the fallback when session is nil, the active path.
// It returns false when the run is no longer current; the caller then owns
// session.
func (m *Manager) adopt(current *run, kind Kind, session transport.Session, reason string) bool {
	m.mu.Lock()
	if m.run != current || m.closed || m.revoked != nil {
		m.mu.Unlock()
		return false
	}
	previous := m.active
	now := m.clock.Now()
	m.pathSeq++
	path := Path{DesktopID: m.desktop.ID, Transport: transport.NameTor, Kind: kind, Since: now}
	if session != nil {
		path.Transport = transport.NameDirect
		path.Address = canonicalAddress(session.RemoteAddr())
	}
	next := &activePath{seq: m.pathSeq, path: path, session: session, stop: make(chan struct{})}
	next.ctx, next.cancel = context.WithCancel(context.Background())
	if m.hadPath {
		m.lastSwitchAt = now
	}
	m.hadPath = true
	m.active = next
	m.retries = 0
	m.lastErr = nil
	m.state = StateConnected
	m.emitPathLocked(PathEvent{DesktopID: path.DesktopID, Transport: path.Transport, Path: kind, Reason: reason})
	if session != nil {
		m.wait.Add(1)
		go m.watch(next)
		if control, ok := session.(transport.ControlSession); ok && m.config.Local != nil {
			m.wait.Add(1)
			go m.keepControl(next, control)
		}
	}
	m.broadcastLocked()
	m.mu.Unlock()
	if path.Address != "" {
		m.config.Logf("pathmgr: %s active over %s at %s, reason %s", path.DesktopID, kind, path.Address, reason)
	} else {
		m.config.Logf("pathmgr: %s active over %s, reason %s", path.DesktopID, kind, reason)
	}
	m.release(previous)
	return true
}

// keepOrAdoptTor keeps the fallback the run started with, or adopts it.
func (m *Manager) keepOrAdoptTor(current *run) bool {
	m.mu.Lock()
	kept := current.kept != nil && m.active == current.kept && m.active.path.Kind == KindTor
	stale := m.run != current
	m.mu.Unlock()
	switch {
	case stale:
		return false
	case kept:
		return true
	}
	return m.adopt(current, KindTor, nil, current.reason)
}

// dropKept removes the path the run started with after the run proved it
// failed, and reports whether the run is still current.
func (m *Manager) dropKept(current *run) bool {
	m.mu.Lock()
	if m.run != current {
		m.mu.Unlock()
		return false
	}
	var dropped *activePath
	if current.kept != nil && m.active == current.kept {
		dropped = m.active
		m.active = nil
		m.lastSwitchAt = m.clock.Now()
		m.state = StateConnecting
		m.broadcastLocked()
	}
	m.mu.Unlock()
	m.release(dropped)
	return true
}

// finish settles the run: the manager stays on its active path or goes
// offline with err and schedules the next retry.
func (m *Manager) finish(current *run, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.run != current {
		return
	}
	m.run = nil
	m.settledSeq = current.seq
	if m.active != nil {
		if m.active.path.Kind == KindTor && (current.plan.direct() || current.punched) && current.started.After(m.lastUpgradeAt) {
			m.lastUpgradeAt = current.started
		}
		m.state = StateConnected
		m.scheduleUpgradeLocked()
	} else {
		if err == nil {
			err = newError(CodeNoPath, nil)
		}
		m.goOfflineLocked(err)
		m.scheduleRetryLocked()
	}
	m.broadcastLocked()
}

func (m *Manager) goOfflineLocked(err error) {
	m.lastErr = err
	m.state = StateOffline
	m.emitPathLocked(PathEvent{DesktopID: m.desktop.ID, Path: KindNone, Reason: Code(err)})
	m.config.Logf("pathmgr: %s offline: %v", m.desktop.ID, err)
}

// pathFailed replaces the active path numbered seq after a proven failure.
func (m *Manager) pathFailed(seq uint64, err error) {
	if isRevoked(err) {
		m.revoke(err)
		return
	}
	m.mu.Lock()
	failed := m.active
	if m.closed || m.revoked != nil || failed == nil || failed.seq != seq {
		m.mu.Unlock()
		return
	}
	m.config.Logf("pathmgr: %s path %s failed: %v", m.desktop.ID, failed.path.Kind, err)
	m.active = nil
	m.lastSwitchAt = m.clock.Now()
	m.retries = 0
	if m.reachable {
		m.startRunLocked(ReasonPathFailed, m.failoverPlan(failed.path.Kind))
	} else {
		m.cancelRunLocked(nil)
		m.stopTimerLocked()
		m.goOfflineLocked(newError(CodeNoPath, errors.Join(errNetworkUnreachable, err)))
		m.broadcastLocked()
	}
	m.mu.Unlock()
	m.release(failed)
}

// revoke ends the manager after the desktop revoked the phone key.
func (m *Manager) revoke(cause error) {
	m.mu.Lock()
	if m.closed || m.revoked != nil {
		m.mu.Unlock()
		return
	}
	m.revoked = newError(CodeRevoked, cause)
	m.cancelRunLocked(m.revoked)
	m.stopTimerLocked()
	active := m.active
	m.active = nil
	m.goOfflineLocked(m.revoked)
	m.broadcastLocked()
	m.mu.Unlock()
	m.release(active)
}

func (m *Manager) watch(active *activePath) {
	defer m.wait.Done()
	select {
	case <-active.session.Done():
		m.pathFailed(active.seq, sessionError(active.session))
	case <-active.stop:
	}
}

func (m *Manager) release(active *activePath) {
	if active == nil {
		return
	}
	active.stopOnce.Do(func() {
		close(active.stop)
		if active.cancel != nil {
			active.cancel()
		}
	})
	if active.session != nil {
		_ = active.session.Close()
	}
}

// upgradeOpenLocked reports whether an improvement attempt is allowed now.
func (m *Manager) upgradeOpenLocked(now time.Time) bool {
	return !now.Before(m.upgradeAtLocked(now))
}

func (m *Manager) upgradeAtLocked(now time.Time) time.Time {
	at := now
	if !m.lastSwitchAt.IsZero() {
		at = latest(at, m.lastSwitchAt.Add(m.timings.Hysteresis))
	}
	if !m.lastUpgradeAt.IsZero() {
		at = latest(at, m.lastUpgradeAt.Add(m.timings.UpgradeInterval))
	}
	return at
}

// claimPunch counts the punch of a run as an improvement attempt when the
// fallback is active and the stability rules allow it.
func (m *Manager) claimPunch(current *run) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.run != current || m.active == nil || m.active.path.Kind != KindTor || m.config.Puncher == nil {
		return false
	}
	now := m.clock.Now()
	if !current.plan.upgrade {
		if !m.upgradeOpenLocked(now) {
			return false
		}
		m.lastUpgradeAt = now
	}
	current.punched = true
	return true
}

func (m *Manager) scheduleUpgradeLocked() {
	m.stopTimerLocked()
	if m.closed || m.revoked != nil || !m.foreground || !m.reachable || m.run != nil ||
		m.active == nil || m.active.path.Kind != KindTor || (m.config.Direct == nil && m.config.Puncher == nil) {
		return
	}
	now := m.clock.Now()
	seq := m.timerSeq
	m.timer = m.clock.AfterFunc(m.upgradeAtLocked(now).Sub(now), func() { m.upgradeDue(seq) })
}

func (m *Manager) upgradeDue(seq uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if seq != m.timerSeq || m.closed || m.revoked != nil || !m.foreground || !m.reachable ||
		m.run != nil || m.active == nil || m.active.path.Kind != KindTor {
		return
	}
	now := m.clock.Now()
	if !m.upgradeOpenLocked(now) {
		m.scheduleUpgradeLocked()
		return
	}
	m.lastUpgradeAt = now
	m.startRunLocked(ReasonUpgrade, plan{lan: true, internet: true, punch: true, upgrade: true})
}

func (m *Manager) scheduleRetryLocked() {
	m.stopTimerLocked()
	if m.closed || m.revoked != nil || !m.reachable || m.retries >= len(m.timings.Retries) {
		return
	}
	delay := m.timings.Retries[m.retries]
	m.retries++
	seq := m.timerSeq
	m.timer = m.clock.AfterFunc(delay, func() { m.retryDue(seq) })
}

func (m *Manager) retryDue(seq uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if seq != m.timerSeq || m.closed || m.revoked != nil || !m.reachable || m.run != nil || m.active != nil {
		return
	}
	m.startRunLocked(ReasonRetry, m.fullPlan())
}

// stopTimerLocked cancels the pending retry or improvement timer. The
// sequence number also voids a callback already running.
func (m *Manager) stopTimerLocked() {
	m.timerSeq++
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
}

func (m *Manager) setTor(status TorStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tor == status {
		return
	}
	m.tor = status
	if handle := m.config.OnTor; handle != nil {
		m.events.post(func() { handle(status) })
	}
}

func (m *Manager) emitPathLocked(event PathEvent) {
	if event.Path == KindNone && event == m.lastEvent {
		return
	}
	m.lastEvent = event
	if handle := m.config.OnPath; handle != nil {
		m.events.post(func() { handle(event) })
	}
}

func (m *Manager) broadcastLocked() {
	close(m.changed)
	m.changed = make(chan struct{})
}

// currentDesktop and directCandidates read the card under the lock, since
// UpdateCard may renew it during an evaluation.
func (m *Manager) currentDesktop() Desktop {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.desktop
}

func (m *Manager) directCandidates(p plan) (lan, internet []netip.AddrPort) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.lan {
		lan = append(lan, m.reportedLAN...)
	}
	if m.card.Expired(m.clock.Now()) {
		return lan, internet
	}
	for _, candidate := range m.card.Candidates {
		address, err := netip.ParseAddrPort(candidate.Address)
		if err != nil {
			continue
		}
		switch {
		case candidate.Type == pairing.CandidateLAN && p.lan && !slices.Contains(lan, address):
			lan = append(lan, address)
		case candidate.Type != pairing.CandidateLAN && p.internet:
			internet = append(internet, address)
		}
	}
	return lan, internet
}

func sessionError(session transport.Session) error {
	if failing, ok := session.(interface{ Err() error }); ok {
		if err := failing.Err(); err != nil {
			return err
		}
	}
	return transport.ErrClosed
}

func canonicalAddress(address net.Addr) string {
	if address == nil {
		return ""
	}
	if udp, ok := address.(*net.UDPAddr); ok {
		port := udp.AddrPort()
		return netip.AddrPortFrom(port.Addr().Unmap(), port.Port()).String()
	}
	if parsed, err := netip.ParseAddrPort(address.String()); err == nil {
		return netip.AddrPortFrom(parsed.Addr().Unmap(), parsed.Port()).String()
	}
	return address.String()
}

func latest(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func orDefault(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
