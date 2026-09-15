// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// Default timings. The hello budget allows for Tor latency; the keepalive
// finds a dead Tor circuit, which has no QUIC idle timeout of its own.
const (
	DefaultHelloTimeout = 20 * time.Second
	DefaultPingInterval = 10 * time.Second
	DefaultWriteTimeout = 15 * time.Second
	DefaultPunchTimeout = 5 * time.Second
	idleIntervals       = 3
	outboxSize          = 16
	replyBacklog        = 16
	maxKeepalivePending = 4
)

// Config describes one side of a control channel.
type Config struct {
	// Role is identity.RolePhone or identity.RoleDesktop; the peer must
	// announce the other one.
	Role identity.Role
	// LocalKey is the canonical public key of this device, sent in hello.
	LocalKey string
	// PeerKey is the key proven by the transport handshake. When the stream
	// belongs to a transport.Session it is taken from the session, and a
	// different non-empty value is refused.
	PeerKey string
	// Puncher sends opening packets on the desktop and dials candidates on
	// the phone. Without it the desktop refuses punches and Punch fails.
	Puncher transport.Puncher
	Handler Handler
	// HelloTimeout bounds the hello exchange; zero means DefaultHelloTimeout.
	HelloTimeout time.Duration
	// PingInterval spaces keepalive pings; zero means DefaultPingInterval and
	// a negative value disables them.
	PingInterval time.Duration
	// IdleTimeout closes the channel when nothing arrives for that long; zero
	// means three ping intervals, or no limit when pings are disabled, and a
	// negative value disables it.
	IdleTimeout time.Duration
	// WriteTimeout bounds one frame write on streams with write deadlines;
	// zero means DefaultWriteTimeout.
	WriteTimeout time.Duration
	// PunchTimeout bounds the opening packets the desktop sends for one
	// request, and Punch when its context has no deadline; zero means
	// DefaultPunchTimeout.
	PunchTimeout time.Duration
	// Now is the clock of candidate expiry; nil means time.Now.
	Now func() time.Time
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

// Handler receives what the peer sends. Candidates, ReachUpdate and
// PathReport run in arrival order on the read goroutine. Every callback must
// return quickly and must not call Close, which waits for them. A nil
// function ignores the message.
type Handler struct {
	// Candidates receives every candidate list the peer announces.
	Candidates func(CandidateSet)
	// ReachUpdate receives each reach card renewed by the desktop, already
	// checked against the authenticated desktop key. An expired card is
	// delivered too; see candidates.Card.Expired.
	ReachUpdate func(candidates.Card)
	// PathReport receives the path the phone reports.
	PathReport func(PathReport)
	// PunchServed receives the outcome of each punch the desktop ran for the
	// phone. It runs on the goroutine of that punch, possibly beside the
	// other callbacks.
	PunchServed func(PunchResult)
}

// CandidateSet is one candidate list sent or received on the channel.
type CandidateSet struct {
	// Seq is the sequence number of the frame that carried the list; a punch
	// request names it.
	Seq        uint64
	Candidates []pairing.Candidate
	// At is when the list was sent or received, by Config.Now; ExpiresAt adds
	// its TTL to that moment.
	At        time.Time
	ExpiresAt time.Time
}

// Expired reports whether the list is past its TTL.
func (set CandidateSet) Expired(now time.Time) bool { return !now.Before(set.ExpiresAt) }

// AddrPorts returns the candidate addresses, as transport.Puncher takes them.
func (set CandidateSet) AddrPorts() []netip.AddrPort {
	addresses := make([]netip.AddrPort, 0, len(set.Candidates))
	for _, candidate := range set.Candidates {
		if address, err := netip.ParseAddrPort(candidate.Address); err == nil {
			addresses = append(addresses, address)
		}
	}
	return addresses
}

func (set CandidateSet) clone() CandidateSet {
	set.Candidates = slices.Clone(set.Candidates)
	return set
}

// Conn is one authenticated control channel between a phone and a desktop.
// Its methods are safe for concurrent use.
type Conn struct {
	stream     io.ReadWriteCloser
	config     Config
	peerRole   identity.Role
	peerPublic ed25519.PublicKey
	started    time.Time

	ctx       context.Context
	cancel    context.CancelFunc
	outbox    chan *outgoing
	replies   chan *outgoing
	done      chan struct{}
	helloDone chan struct{}
	once      sync.Once
	wait      sync.WaitGroup

	// lastReceived is the time since started of the last frame read.
	lastReceived atomic.Int64
	// sentSeq is the sequence number of the last frame handed to the stream.
	sentSeq atomic.Uint64
	// recvSeq and gotHello belong to the read goroutine.
	recvSeq  uint64
	gotHello bool

	mu          sync.Mutex
	err         error
	local       CandidateSet
	hasLocal    bool
	peer        CandidateSet
	hasPeer     bool
	peerChanged chan struct{}
	pings       map[uint64]*pendingPing
	punches     map[uint64]chan punchAck
	punching    bool
}

type outgoing struct {
	message message
	// onSeq runs on the write goroutine once the sequence number is known and
	// before the frame is written, so an answer always finds its request.
	onSeq func(seq uint64)
	// written receives the write result; nil when nobody waits.
	written chan error
}

type pendingPing struct {
	sentAt time.Time
	reply  chan time.Duration
}

// Open opens the control stream of a dialed session and runs the hello
// exchange on it.
func Open(ctx context.Context, session transport.ControlSession, config Config) (*Conn, error) {
	stream, err := session.OpenControl(ctx)
	if err != nil {
		return nil, fmt.Errorf("open control stream: %w", err)
	}
	return Establish(ctx, stream, config)
}

// Accept waits for the control stream of an accepted session and runs the
// hello exchange on it.
func Accept(ctx context.Context, session transport.ControlSession, config Config) (*Conn, error) {
	stream, err := session.AcceptControl(ctx)
	if err != nil {
		return nil, fmt.Errorf("accept control stream: %w", err)
	}
	return Establish(ctx, stream, config)
}

// Establish runs the hello exchange on stream, such as the QUIC control stream
// or a TLS connection over Tor, and returns the channel once the peer hello
// matched the authenticated key and the expected role. Both sides send hello
// at once. The channel owns stream from this call on: it is closed on failure
// and by Close.
func Establish(ctx context.Context, stream io.ReadWriteCloser, config Config) (*Conn, error) {
	if stream == nil {
		return nil, errors.New("rendezvous stream is required")
	}
	if err := config.fromStream(stream); err != nil {
		_ = stream.Close()
		return nil, err
	}
	if err := config.normalize(); err != nil {
		_ = stream.Close()
		return nil, err
	}
	conn := newConn(stream, config)
	// hello is queued before the read goroutine starts, so no answer can
	// precede it on the wire.
	conn.outbox <- &outgoing{message: message{Type: typeHello, Hello: &hello{
		Proto: ProtocolVersion, Role: string(config.Role), Key: config.LocalKey,
	}}}
	conn.wait.Add(2)
	go conn.writeLoop()
	go conn.readLoop()

	timer := time.NewTimer(conn.config.HelloTimeout)
	defer timer.Stop()
	select {
	case <-conn.helloDone:
	case <-ctx.Done():
		conn.fail(fmt.Errorf("rendezvous hello: %w", ctx.Err()))
	case <-timer.C:
		conn.fail(fmt.Errorf("rendezvous hello: no answer in %s: %w", conn.config.HelloTimeout, context.DeadlineExceeded))
	case <-conn.done:
	}
	if err := conn.Err(); err != nil {
		conn.fail(err)
		conn.wait.Wait()
		return nil, err
	}
	if conn.config.PingInterval > 0 || conn.config.IdleTimeout > 0 {
		conn.wait.Add(1)
		go conn.keepalive()
	}
	return conn, nil
}

func (config *Config) fromStream(stream io.ReadWriteCloser) error {
	carried, ok := stream.(interface{ Session() transport.Session })
	if !ok || carried.Session() == nil {
		return nil
	}
	key := carried.Session().PeerKey()
	switch config.PeerKey {
	case "":
		config.PeerKey = key
	case key:
	default:
		return fmt.Errorf("%w: configured key differs from the session key", ErrPeerMismatch)
	}
	return nil
}

func (config *Config) normalize() error {
	if config.Role != identity.RolePhone && config.Role != identity.RoleDesktop {
		return fmt.Errorf("rendezvous role %q is unknown", config.Role)
	}
	if _, err := identity.ParsePublicKey(config.LocalKey); err != nil {
		return fmt.Errorf("rendezvous local key: %w", err)
	}
	if _, err := identity.ParsePublicKey(config.PeerKey); err != nil {
		return fmt.Errorf("rendezvous peer key: %w", err)
	}
	config.HelloTimeout = orDefault(config.HelloTimeout, DefaultHelloTimeout)
	config.WriteTimeout = orDefault(config.WriteTimeout, DefaultWriteTimeout)
	config.PunchTimeout = orDefault(config.PunchTimeout, DefaultPunchTimeout)
	switch {
	case config.PingInterval == 0:
		config.PingInterval = DefaultPingInterval
	case config.PingInterval < 0:
		config.PingInterval = 0
	}
	switch {
	case config.IdleTimeout == 0:
		config.IdleTimeout = idleIntervals * config.PingInterval
	case config.IdleTimeout < 0:
		config.IdleTimeout = 0
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Logf == nil {
		config.Logf = func(string, ...any) {}
	}
	return nil
}

func newConn(stream io.ReadWriteCloser, config Config) *Conn {
	peerRole := identity.RoleDesktop
	if config.Role == identity.RoleDesktop {
		peerRole = identity.RolePhone
	}
	peerPublic, _ := identity.ParsePublicKey(config.PeerKey)
	ctx, cancel := context.WithCancel(context.Background())
	return &Conn{
		stream:      stream,
		config:      config,
		peerRole:    peerRole,
		peerPublic:  peerPublic,
		started:     time.Now(),
		ctx:         ctx,
		cancel:      cancel,
		outbox:      make(chan *outgoing, outboxSize),
		replies:     make(chan *outgoing, replyBacklog),
		done:        make(chan struct{}),
		helloDone:   make(chan struct{}),
		peerChanged: make(chan struct{}),
		pings:       make(map[uint64]*pendingPing),
		punches:     make(map[uint64]chan punchAck),
	}
}

// Role is the local role.
func (conn *Conn) Role() identity.Role { return conn.config.Role }

// PeerKey is the authenticated key of the peer.
func (conn *Conn) PeerKey() string { return conn.config.PeerKey }

// Done is closed when the channel ends for any reason.
func (conn *Conn) Done() <-chan struct{} { return conn.done }

// Err tells why the channel ended, or returns nil while it is open. Close
// ends it with transport.ErrClosed.
func (conn *Conn) Err() error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	return conn.err
}

// Close ends the channel, closes the stream and waits for the goroutines of
// the channel, punches in progress included.
func (conn *Conn) Close() error {
	conn.fail(transport.ErrClosed)
	conn.wait.Wait()
	return nil
}

// SendCandidates announces the local candidates for ttl, DefaultCandidateTTL
// when zero. Invalid and repeated candidates and those beyond MaxCandidates
// are skipped, keeping the order; an empty list withdraws the previous one.
// It returns the list as sent.
func (conn *Conn) SendCandidates(ctx context.Context, list []pairing.Candidate, ttl time.Duration) (CandidateSet, error) {
	if ttl == 0 {
		ttl = DefaultCandidateTTL
	}
	if ttl < MinCandidateTTL || ttl > MaxCandidateTTL {
		return CandidateSet{}, fmt.Errorf("candidate TTL %s is outside [%s, %s]", ttl, MinCandidateTTL, MaxCandidateTTL)
	}
	usable := usableCandidates(list)
	var sent CandidateSet
	err := conn.send(ctx, message{Type: typeCandidates, Candidates: &candidateList{
		TTLMillis: int64(ttl / time.Millisecond), Candidates: usable,
	}}, func(seq uint64) {
		now := conn.config.Now()
		sent = CandidateSet{Seq: seq, Candidates: usable, At: now, ExpiresAt: now.Add(ttl)}
		conn.mu.Lock()
		conn.local, conn.hasLocal = sent, true
		conn.mu.Unlock()
	})
	if err != nil {
		return CandidateSet{}, err
	}
	return sent.clone(), nil
}

// SendReachUpdate renews the reach card of the phone. Only the desktop sends
// it, and the card must carry the local key.
func (conn *Conn) SendReachUpdate(ctx context.Context, card candidates.Card) error {
	if card.Desktop.PublicKey != conn.config.LocalKey {
		return fmt.Errorf("%w: reach card belongs to another desktop", ErrPeerMismatch)
	}
	return conn.send(ctx, message{Type: typeReachUpdate, ReachUpdate: &card}, nil)
}

// ReportPath tells the desktop which path the phone uses. Only the phone
// sends it.
func (conn *Conn) ReportPath(ctx context.Context, report PathReport) error {
	return conn.send(ctx, message{Type: typePathReport, PathReport: &report}, nil)
}

// Ping measures the round trip of the channel.
func (conn *Conn) Ping(ctx context.Context) (time.Duration, error) {
	reply := make(chan time.Duration, 1)
	err := conn.send(ctx, message{Type: typePing}, func(seq uint64) {
		conn.mu.Lock()
		conn.pings[seq] = &pendingPing{sentAt: time.Now(), reply: reply}
		conn.mu.Unlock()
	})
	if err != nil {
		return 0, err
	}
	select {
	case rtt := <-reply:
		return rtt, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-conn.done:
		return 0, conn.Err()
	}
}

// LocalCandidates returns the last list this side sent while it is fresh.
func (conn *Conn) LocalCandidates() (CandidateSet, bool) {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if !conn.hasLocal || conn.local.Expired(conn.config.Now()) {
		return CandidateSet{}, false
	}
	return conn.local.clone(), true
}

// PeerCandidates returns the last list the peer sent while it is fresh.
func (conn *Conn) PeerCandidates() (CandidateSet, bool) {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if !conn.hasPeer || conn.peer.Expired(conn.config.Now()) {
		return CandidateSet{}, false
	}
	return conn.peer.clone(), true
}

// send validates msg, queues it and waits until it is written. When ctx ends
// after the frame was queued, the frame may still reach the peer.
func (conn *Conn) send(ctx context.Context, msg message, onSeq func(uint64)) error {
	if !maySend(msg.Type, conn.config.Role) {
		return fmt.Errorf("%w: the %s does not send %s", ErrProtocol, conn.config.Role, msg.Type)
	}
	if err := checkEncodable(msg); err != nil {
		return err
	}
	out := &outgoing{message: msg, onSeq: onSeq, written: make(chan error, 1)}
	select {
	case <-conn.done:
		return conn.Err()
	default:
	}
	select {
	case conn.outbox <- out:
	case <-ctx.Done():
		return ctx.Err()
	case <-conn.done:
		return conn.Err()
	}
	select {
	case err := <-out.written:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-conn.done:
		select {
		case err := <-out.written:
			return err
		default:
			return conn.Err()
		}
	}
}

// reply queues an answer from the read goroutine without blocking it. A full
// backlog means the peer keeps asking without reading the answers.
func (conn *Conn) reply(msg message) error {
	select {
	case conn.replies <- &outgoing{message: msg}:
		return nil
	default:
		return fmt.Errorf("%w: %d answers wait for a peer that is not reading", ErrProtocol, replyBacklog)
	}
}

func (conn *Conn) fail(err error) {
	conn.once.Do(func() {
		conn.mu.Lock()
		conn.err = err
		conn.mu.Unlock()
		close(conn.done)
		conn.cancel()
		_ = conn.stream.Close()
	})
}

func (conn *Conn) writeLoop() {
	defer conn.wait.Done()
	var seq uint64
	frame := make([]byte, 0, 1024)
	for {
		var out *outgoing
		// Answers go first so a busy sender cannot starve pongs and acks.
		select {
		case out = <-conn.replies:
		default:
			select {
			case out = <-conn.replies:
			case out = <-conn.outbox:
			case <-conn.done:
				return
			}
		}
		seq++
		out.message.Seq = seq
		payload, err := encodeMessage(out.message)
		if err != nil {
			// send checked the message already; this is a programming error.
			conn.fail(err)
			report(out, err)
			return
		}
		if out.onSeq != nil {
			out.onSeq(seq)
		}
		conn.sentSeq.Store(seq)
		frame = appendFrame(frame[:0], payload)
		err = conn.write(frame)
		report(out, err)
		if err != nil {
			conn.fail(fmt.Errorf("write rendezvous frame: %w", err))
			return
		}
	}
}

func report(out *outgoing, err error) {
	if out.written != nil {
		out.written <- err
	}
}

func (conn *Conn) write(frame []byte) error {
	if deadline, ok := conn.stream.(interface{ SetWriteDeadline(time.Time) error }); ok {
		_ = deadline.SetWriteDeadline(time.Now().Add(conn.config.WriteTimeout))
	}
	for len(frame) > 0 {
		written, err := conn.stream.Write(frame)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		frame = frame[written:]
	}
	return nil
}

func (conn *Conn) readLoop() {
	defer conn.wait.Done()
	reader := bufio.NewReader(conn.stream)
	buffer := make([]byte, MaxFrameSize)
	for {
		raw, err := readFrame(reader, buffer)
		if err != nil {
			conn.fail(readError(err))
			return
		}
		conn.lastReceived.Store(int64(time.Since(conn.started)))
		msg, err := decodeMessage(raw)
		if err == nil {
			err = conn.receive(msg)
		}
		if err != nil {
			conn.config.Logf("rendezvous: closing channel with %s: %v", conn.config.PeerKey, err)
			conn.fail(err)
			return
		}
	}
}

func readError(err error) error {
	switch {
	case errors.Is(err, ErrInvalidFrame), errors.Is(err, ErrFrameTooLarge):
		return err
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return fmt.Errorf("%w: the peer ended the channel: %w", transport.ErrClosed, err)
	default:
		return fmt.Errorf("read rendezvous frame: %w", err)
	}
}

// receive applies one decoded frame in stream order.
func (conn *Conn) receive(msg message) error {
	switch {
	case msg.Seq <= conn.recvSeq:
		return fmt.Errorf("%w: %s seq %d after seq %d", ErrReplay, msg.Type, msg.Seq, conn.recvSeq)
	case msg.Seq != conn.recvSeq+1:
		return fmt.Errorf("%w: seq %d skips seq %d", ErrProtocol, msg.Seq, conn.recvSeq+1)
	}
	conn.recvSeq = msg.Seq
	if !conn.gotHello {
		if msg.Type != typeHello {
			return fmt.Errorf("%w: first frame is %s instead of hello", ErrProtocol, msg.Type)
		}
		if err := conn.checkHello(msg.Hello); err != nil {
			return err
		}
		conn.gotHello = true
		close(conn.helloDone)
		return nil
	}
	if !maySend(msg.Type, conn.peerRole) {
		return fmt.Errorf("%w: the %s may not send %s", ErrProtocol, conn.peerRole, msg.Type)
	}
	switch msg.Type {
	case typeHello:
		return fmt.Errorf("%w: repeated hello", ErrProtocol)
	case typeCandidates:
		conn.receiveCandidates(msg.Seq, msg.Candidates)
	case typePunchRequest:
		return conn.servePunch(msg.Seq, msg.PunchRequest)
	case typePunchAck:
		return conn.receivePunchAck(msg.PunchAck)
	case typeReachUpdate:
		return conn.receiveReachUpdate(msg.ReachUpdate)
	case typePathReport:
		if handle := conn.config.Handler.PathReport; handle != nil {
			handle(*msg.PathReport)
		}
	case typePing:
		return conn.reply(message{Type: typePong, Pong: &pong{Ping: msg.Seq}})
	case typePong:
		return conn.receivePong(msg.Pong)
	}
	return nil
}

func (conn *Conn) checkHello(body *hello) error {
	if body.Proto != ProtocolVersion {
		return fmt.Errorf("%w: peer speaks version %d, this side %d", ErrUnsupportedVersion, body.Proto, ProtocolVersion)
	}
	if identity.Role(body.Role) != conn.peerRole {
		return fmt.Errorf("%w: peer announced role %s instead of %s", ErrPeerMismatch, body.Role, conn.peerRole)
	}
	if subtle.ConstantTimeCompare([]byte(body.Key), []byte(conn.config.PeerKey)) != 1 {
		return fmt.Errorf("%w: hello key differs from the transport key", ErrPeerMismatch)
	}
	return nil
}

func (conn *Conn) receiveCandidates(seq uint64, body *candidateList) {
	now := conn.config.Now()
	set := CandidateSet{
		Seq: seq, Candidates: body.Candidates, At: now,
		ExpiresAt: now.Add(time.Duration(body.TTLMillis) * time.Millisecond),
	}
	conn.mu.Lock()
	conn.peer, conn.hasPeer = set, true
	close(conn.peerChanged)
	conn.peerChanged = make(chan struct{})
	conn.mu.Unlock()
	if handle := conn.config.Handler.Candidates; handle != nil {
		handle(set.clone())
	}
}

func (conn *Conn) receiveReachUpdate(card *candidates.Card) error {
	if subtle.ConstantTimeCompare([]byte(card.Desktop.PublicKey), []byte(conn.config.PeerKey)) != 1 {
		return fmt.Errorf("%w: reach card names another desktop key", ErrPeerMismatch)
	}
	if handle := conn.config.Handler.ReachUpdate; handle != nil {
		handle(*card)
	}
	return nil
}

func (conn *Conn) receivePong(body *pong) error {
	conn.mu.Lock()
	pending, ok := conn.pings[body.Ping]
	delete(conn.pings, body.Ping)
	conn.mu.Unlock()
	if !ok {
		return conn.unmatchedAnswer(typePong, body.Ping)
	}
	if pending.reply != nil {
		pending.reply <- time.Since(pending.sentAt)
	}
	return nil
}

// unmatchedAnswer classifies an answer without a pending request: naming a
// frame never sent is a protocol violation, anything else a repetition.
func (conn *Conn) unmatchedAnswer(kind messageType, request uint64) error {
	if request > conn.sentSeq.Load() {
		return fmt.Errorf("%w: %s names frame %d, which was never sent", ErrProtocol, kind, request)
	}
	return fmt.Errorf("%w: %s for frame %d, which awaits no answer", ErrReplay, kind, request)
}

func (conn *Conn) keepalive() {
	defer conn.wait.Done()
	interval := conn.config.PingInterval
	if interval == 0 {
		interval = max(conn.config.IdleTimeout/idleIntervals, time.Millisecond)
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-conn.done:
			return
		case <-ticker.C:
		}
		idle := time.Since(conn.started) - time.Duration(conn.lastReceived.Load())
		if limit := conn.config.IdleTimeout; limit > 0 && idle >= limit {
			conn.fail(fmt.Errorf("%w: nothing received for %s", ErrIdleTimeout, idle.Round(time.Millisecond)))
			return
		}
		if conn.config.PingInterval > 0 {
			conn.keepalivePing()
		}
	}
}

// keepalivePing queues a ping nobody waits for; it skips the round while the
// queue is full or earlier pings are still unanswered.
func (conn *Conn) keepalivePing() {
	conn.mu.Lock()
	pending := len(conn.pings)
	conn.mu.Unlock()
	if pending >= maxKeepalivePending {
		return
	}
	out := &outgoing{message: message{Type: typePing}, onSeq: func(seq uint64) {
		conn.mu.Lock()
		conn.pings[seq] = &pendingPing{sentAt: time.Now()}
		conn.mu.Unlock()
	}}
	select {
	case conn.outbox <- out:
	default:
	}
}

func orDefault(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
