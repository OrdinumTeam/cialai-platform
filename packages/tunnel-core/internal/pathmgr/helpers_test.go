// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"net"
	"net/netip"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// The unit tests run inside a synctest bubble, but the manager only sees the
// fakeClock below: synctest.Wait is used to let every goroutine of the manager
// settle before the fake clock moves on, so each timer fires in order against
// a quiet manager.

var epoch = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	clock *fakeClock
	when  time.Time
	call  func()
}

func newFakeClock() *fakeClock { return &fakeClock{now: epoch} }

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	timer := &fakeTimer{clock: clock, when: clock.now.Add(d), call: f}
	if d <= 0 {
		go f()
		return timer
	}
	clock.timers = append(clock.timers, timer)
	return timer
}

func (timer *fakeTimer) Stop() bool {
	clock := timer.clock
	clock.mu.Lock()
	defer clock.mu.Unlock()
	index := slices.Index(clock.timers, timer)
	if index < 0 {
		return false
	}
	clock.timers = slices.Delete(clock.timers, index, index+1)
	return true
}

// Elapsed is the fake time since the epoch.
func (clock *fakeClock) Elapsed() time.Duration { return clock.Now().Sub(epoch) }

// Advance moves the clock forward by d, firing due timers in deadline order.
func (clock *fakeClock) Advance(d time.Duration) {
	clock.mu.Lock()
	target := clock.now.Add(d)
	clock.mu.Unlock()
	for {
		synctest.Wait()
		clock.mu.Lock()
		var next *fakeTimer
		for _, timer := range clock.timers {
			if !timer.when.After(target) && (next == nil || timer.when.Before(next.when)) {
				next = timer
			}
		}
		if next == nil {
			clock.now = target
			clock.mu.Unlock()
			break
		}
		if next.when.After(clock.now) {
			clock.now = next.when
		}
		index := slices.Index(clock.timers, next)
		clock.timers = slices.Delete(clock.timers, index, index+1)
		clock.mu.Unlock()
		go next.call()
	}
	synctest.Wait()
}

// AdvanceTo moves the clock to the fake time since the epoch.
func (clock *fakeClock) AdvanceTo(elapsed time.Duration) {
	if delta := elapsed - clock.Elapsed(); delta > 0 {
		clock.Advance(delta)
	}
	synctest.Wait()
}

type dialMode int

const (
	modeRefuse dialMode = iota
	modeHang
	modeAnswer
	modeRevoked
)

type dialCall struct {
	at         time.Duration
	candidates []netip.AddrPort
	err        error
}

// fakeDirect decides each dial by the modes of its candidates: a revoked
// candidate wins, then an answering one, then a hanging one.
type fakeDirect struct {
	clock *fakeClock

	mu       sync.Mutex
	modes    map[netip.AddrPort]dialMode
	delays   map[netip.AddrPort]time.Duration
	calls    []*dialCall
	sessions []*fakeSession
	// life ends every new session after that long; zero keeps it.
	life    time.Duration
	migrate func(ctx context.Context) error
}

func newFakeDirect(clock *fakeClock) *fakeDirect {
	return &fakeDirect{clock: clock, modes: make(map[netip.AddrPort]dialMode), delays: make(map[netip.AddrPort]time.Duration)}
}

func (direct *fakeDirect) set(address string, mode dialMode) {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	direct.modes[netip.MustParseAddrPort(address)] = mode
}

func (direct *fakeDirect) setDelay(address string, delay time.Duration) {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	direct.delays[netip.MustParseAddrPort(address)] = delay
}

func (direct *fakeDirect) DialCandidates(ctx context.Context, list []netip.AddrPort, _ ed25519.PublicKey) (transport.Session, error) {
	direct.mu.Lock()
	call := &dialCall{at: direct.clock.Elapsed(), candidates: slices.Clone(list)}
	direct.calls = append(direct.calls, call)
	mode, target, delay := modeRefuse, netip.AddrPort{}, time.Duration(0)
	for _, candidate := range list {
		if candidateMode := direct.modes[candidate]; candidateMode > mode {
			mode, target, delay = candidateMode, candidate, direct.delays[candidate]
		}
	}
	direct.mu.Unlock()

	var err error
	switch mode {
	case modeRevoked:
		err = transport.ErrRevoked
	case modeRefuse:
		err = errors.New("connection refused")
	case modeHang:
		<-ctx.Done()
		err = ctx.Err()
	case modeAnswer:
		if delay > 0 && !sleep(direct.clock, ctx, delay) {
			err = ctx.Err()
		}
	}
	direct.mu.Lock()
	defer direct.mu.Unlock()
	call.err = err
	if err != nil {
		return nil, err
	}
	session := newFakeSession(target)
	session.migrate = direct.migrate
	direct.sessions = append(direct.sessions, session)
	if direct.life > 0 {
		direct.clock.AfterFunc(direct.life, func() { session.end(transport.ErrClosed) })
	}
	return session, nil
}

func (direct *fakeDirect) callList() []dialCall {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	calls := make([]dialCall, len(direct.calls))
	for i, call := range direct.calls {
		calls[i] = *call
	}
	return calls
}

func (direct *fakeDirect) sessionList() []*fakeSession {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	return slices.Clone(direct.sessions)
}

// sessionTo returns the latest session dialed to address.
func (direct *fakeDirect) sessionTo(address string) *fakeSession {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	for i := len(direct.sessions) - 1; i >= 0; i-- {
		if direct.sessions[i].remote.String() == address {
			return direct.sessions[i]
		}
	}
	return nil
}

func (direct *fakeDirect) session(index int) *fakeSession {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	if index < 0 {
		index += len(direct.sessions)
	}
	return direct.sessions[index]
}

type fakeSession struct {
	remote  netip.AddrPort
	done    chan struct{}
	once    sync.Once
	migrate func(ctx context.Context) error

	mu         sync.Mutex
	err        error
	migrations []net.PacketConn
	streams    int
}

func newFakeSession(remote netip.AddrPort) *fakeSession {
	return &fakeSession{remote: remote, done: make(chan struct{})}
}

func (session *fakeSession) PeerKey() string   { return "" }
func (session *fakeSession) Transport() string { return transport.NameDirect }
func (session *fakeSession) Registered() bool  { return true }
func (session *fakeSession) LocalAddr() net.Addr {
	return &net.UDPAddr{IP: net.IPv4(192, 168, 1, 50), Port: 50000}
}
func (session *fakeSession) RemoteAddr() net.Addr  { return net.UDPAddrFromAddrPort(session.remote) }
func (session *fakeSession) Done() <-chan struct{} { return session.done }
func (session *fakeSession) Close() error          { session.end(transport.ErrClosed); return nil }

func (session *fakeSession) end(err error) {
	session.once.Do(func() {
		session.mu.Lock()
		session.err = err
		session.mu.Unlock()
		close(session.done)
	})
}

func (session *fakeSession) ended() bool {
	select {
	case <-session.done:
		return true
	default:
		return false
	}
}

func (session *fakeSession) Err() error {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.err
}

func (session *fakeSession) OpenStream(context.Context) (transport.Stream, error) {
	if session.ended() {
		return nil, session.Err()
	}
	session.mu.Lock()
	session.streams++
	session.mu.Unlock()
	local, remote := net.Pipe()
	_ = remote.Close()
	return &fakeStream{Conn: local, session: session}, nil
}

func (session *fakeSession) AcceptStream(ctx context.Context) (transport.Stream, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (session *fakeSession) Migrate(ctx context.Context, packetConn net.PacketConn) error {
	if session.migrate == nil {
		return errors.New("path validation failed")
	}
	if err := session.migrate(ctx); err != nil {
		return err
	}
	session.mu.Lock()
	session.migrations = append(session.migrations, packetConn)
	session.mu.Unlock()
	return nil
}

func (session *fakeSession) migrationList() []net.PacketConn {
	session.mu.Lock()
	defer session.mu.Unlock()
	return slices.Clone(session.migrations)
}

type fakeStream struct {
	net.Conn
	session *fakeSession
}

func (stream *fakeStream) Session() transport.Session { return stream.session }

// fakeTor answers bootstrap queries from a script and dials onion
// connections that are only good for closing.
type fakeTor struct {
	clock *fakeClock

	mu        sync.Mutex
	progress  []int
	statusErr error
	dialErr   error
	dialHang  bool
	polls     int
	dials     []time.Duration
}

func newFakeTor(clock *fakeClock) *fakeTor { return &fakeTor{clock: clock} }

func (fake *fakeTor) Bootstrap(context.Context) (tor.Bootstrap, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.polls++
	if fake.statusErr != nil {
		return tor.Bootstrap{}, fake.statusErr
	}
	if len(fake.progress) == 0 {
		return tor.Bootstrap{Progress: 100, Tag: "done"}, nil
	}
	progress := fake.progress[0]
	if len(fake.progress) > 1 {
		fake.progress = fake.progress[1:]
	}
	return tor.Bootstrap{Progress: progress}, nil
}

func (fake *fakeTor) DialTLS(ctx context.Context, _ string, _ *identity.Identity, _ ed25519.PublicKey) (*tls.Conn, error) {
	fake.mu.Lock()
	fake.dials = append(fake.dials, fake.clock.Elapsed())
	hang, err := fake.dialHang, fake.dialErr
	fake.mu.Unlock()
	if hang {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	local, remote := net.Pipe()
	_ = remote.Close()
	return tls.Client(local, &tls.Config{InsecureSkipVerify: true}), nil
}

func (fake *fakeTor) setDialErr(err error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.dialErr = err
}

func (fake *fakeTor) dialCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return len(fake.dials)
}

type fakePuncher struct {
	clock *fakeClock

	mu       sync.Mutex
	answer   netip.AddrPort
	err      error
	calls    []time.Duration
	sessions []*fakeSession
}

// punchDelay is how long a successful fake punch takes.
const punchDelay = 500 * time.Millisecond

func (puncher *fakePuncher) set(answer netip.AddrPort, err error) {
	puncher.mu.Lock()
	defer puncher.mu.Unlock()
	puncher.answer, puncher.err = answer, err
}

func (puncher *fakePuncher) sessionList() []*fakeSession {
	puncher.mu.Lock()
	defer puncher.mu.Unlock()
	return slices.Clone(puncher.sessions)
}

func (puncher *fakePuncher) lastSession() *fakeSession {
	puncher.mu.Lock()
	defer puncher.mu.Unlock()
	return puncher.sessions[len(puncher.sessions)-1]
}

func (puncher *fakePuncher) Punch(ctx context.Context, _ Desktop) (transport.Session, error) {
	puncher.mu.Lock()
	puncher.calls = append(puncher.calls, puncher.clock.Elapsed())
	answer, err := puncher.answer, puncher.err
	puncher.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if !answer.IsValid() || !sleep(puncher.clock, ctx, punchDelay) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	session := newFakeSession(answer)
	puncher.mu.Lock()
	puncher.sessions = append(puncher.sessions, session)
	puncher.mu.Unlock()
	return session, nil
}

func (puncher *fakePuncher) callTimes() []time.Duration {
	puncher.mu.Lock()
	defer puncher.mu.Unlock()
	return slices.Clone(puncher.calls)
}

type timedEvent struct {
	at    time.Duration
	event PathEvent
}

type recorder struct {
	clock *fakeClock

	mu    sync.Mutex
	paths []timedEvent
	tor   []TorStatus
}

func (events *recorder) onPath(event PathEvent) {
	events.mu.Lock()
	defer events.mu.Unlock()
	events.paths = append(events.paths, timedEvent{at: events.clock.Elapsed(), event: event})
}

func (events *recorder) onTor(status TorStatus) {
	events.mu.Lock()
	defer events.mu.Unlock()
	events.tor = append(events.tor, status)
}

func (events *recorder) pathList() []timedEvent {
	events.mu.Lock()
	defer events.mu.Unlock()
	return slices.Clone(events.paths)
}

func (events *recorder) torList() []TorStatus {
	events.mu.Lock()
	defer events.mu.Unlock()
	return slices.Clone(events.tor)
}

// Candidate addresses of the test card.
const (
	lanAddress    = "192.168.1.10:4740"
	stunAddress   = "203.0.113.7:40000"
	punchAddress  = "198.51.100.9:41000"
	reportedLocal = "192.168.1.11:4740"
)

type harness struct {
	t       *testing.T
	clock   *fakeClock
	phone   *identity.Identity
	desktop *identity.Identity
	card    candidates.Card
	direct  *fakeDirect
	tor     *fakeTor
	puncher *fakePuncher
	events  *recorder
	manager *Manager
	sockets *socketLog
}

type harnessOption func(*Config, *harness)

func withoutTor() harnessOption {
	return func(config *Config, _ *harness) { config.Tor = nil }
}

func withoutPuncher() harnessOption {
	return func(config *Config, _ *harness) { config.Puncher = nil }
}

func withCard(list ...pairing.Candidate) harnessOption {
	return func(config *Config, h *harness) {
		h.card = testCard(h.t, h.desktop, list...)
		config.Card = h.card
	}
}

func newHarness(t *testing.T, options ...harnessOption) *harness {
	t.Helper()
	clock := newFakeClock()
	h := &harness{
		t:       t,
		clock:   clock,
		phone:   mustIdentity(t, identity.RolePhone),
		desktop: mustIdentity(t, identity.RoleDesktop),
		direct:  newFakeDirect(clock),
		tor:     newFakeTor(clock),
		puncher: &fakePuncher{clock: clock, err: errors.New("punch refused")},
		events:  &recorder{clock: clock},
		sockets: &socketLog{},
	}
	h.card = testCard(t, h.desktop,
		pairing.Candidate{Type: pairing.CandidateLAN, Address: lanAddress},
		pairing.Candidate{Type: pairing.CandidateSTUN, Address: stunAddress})
	config := Config{
		Card:         h.card,
		Local:        h.phone,
		Direct:       h.direct,
		Tor:          h.tor,
		Puncher:      h.puncher,
		ListenPacket: h.sockets.listen,
		Clock:        clock,
		OnPath:       h.events.onPath,
		OnTor:        h.events.onTor,
	}
	for _, option := range options {
		option(&config, h)
	}
	manager, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	h.manager = manager
	t.Cleanup(func() { _ = manager.Close() })
	return h
}

func mustIdentity(t testing.TB, role identity.Role) *identity.Identity {
	t.Helper()
	generated, err := identity.Generate(role, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return generated
}

func testCard(t testing.TB, desktop *identity.Identity, list ...pairing.Candidate) candidates.Card {
	t.Helper()
	onionKey, err := tor.GenerateOnionKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if list == nil {
		list = []pairing.Candidate{}
	}
	card, err := candidates.NewCard(pairing.Desktop{ID: desktop.ID(), Name: "Mac do estúdio", PublicKey: desktop.PublicKeyString()},
		onionKey.Address()+":443", list, epoch, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return card
}

type connectOutcome struct {
	result Result
	err    error
	at     time.Duration
}

// connect starts Connect on its own goroutine.
func (h *harness) connect() <-chan connectOutcome {
	outcome := make(chan connectOutcome, 1)
	go func() {
		result, err := h.manager.Connect(context.Background())
		outcome <- connectOutcome{result: result, err: err, at: h.clock.Elapsed()}
	}()
	synctest.Wait()
	return outcome
}

// mustConnect runs Connect, advancing the clock until it returns.
func (h *harness) mustConnect(want Kind) Result {
	h.t.Helper()
	outcome := h.connect()
	result := h.await(outcome, time.Minute)
	if result.err != nil {
		h.t.Fatalf("Connect = %v, want %s", result.err, want)
	}
	if result.result.Path != want {
		h.t.Fatalf("Connect path = %s, want %s", result.result.Path, want)
	}
	return result.result
}

// await advances the clock in small steps until outcome is ready.
func (h *harness) await(outcome <-chan connectOutcome, limit time.Duration) connectOutcome {
	h.t.Helper()
	for waited := time.Duration(0); waited <= limit; waited += 100 * time.Millisecond {
		select {
		case result := <-outcome:
			return result
		default:
		}
		h.clock.Advance(100 * time.Millisecond)
	}
	h.t.Fatalf("Connect did not return within %s of fake time", limit)
	return connectOutcome{}
}

func (h *harness) expectActive(kind Kind) Path {
	h.t.Helper()
	synctest.Wait()
	active := h.manager.Active()
	if active.Kind != kind {
		h.t.Fatalf("active path = %q, want %q (status %+v)", active.Kind, kind, h.manager.Status())
	}
	return active
}

func (h *harness) lastEvent() timedEvent {
	h.t.Helper()
	events := h.events.pathList()
	if len(events) == 0 {
		h.t.Fatal("no path event")
	}
	return events[len(events)-1]
}

// socketLog hands out fake migration sockets and remembers them.
type socketLog struct {
	mu      sync.Mutex
	sockets []*fakePacketConn
}

func (log *socketLog) listen() (net.PacketConn, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	socket := &fakePacketConn{}
	log.sockets = append(log.sockets, socket)
	return socket, nil
}

func (log *socketLog) list() []*fakePacketConn {
	log.mu.Lock()
	defer log.mu.Unlock()
	return slices.Clone(log.sockets)
}

type fakePacketConn struct {
	mu     sync.Mutex
	closed bool
}

func (conn *fakePacketConn) ReadFrom([]byte) (int, net.Addr, error) { return 0, nil, net.ErrClosed }
func (conn *fakePacketConn) WriteTo(b []byte, _ net.Addr) (int, error) {
	return len(b), nil
}
func (conn *fakePacketConn) Close() error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	conn.closed = true
	return nil
}
func (conn *fakePacketConn) isClosed() bool {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	return conn.closed
}
func (conn *fakePacketConn) LocalAddr() net.Addr {
	return &net.UDPAddr{IP: net.IPv4(10, 20, 0, 5), Port: 50001}
}
func (conn *fakePacketConn) SetDeadline(time.Time) error      { return nil }
func (conn *fakePacketConn) SetReadDeadline(time.Time) error  { return nil }
func (conn *fakePacketConn) SetWriteDeadline(time.Time) error { return nil }
