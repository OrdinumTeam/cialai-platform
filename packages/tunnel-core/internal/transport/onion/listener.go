// SPDX-License-Identifier: Apache-2.0
// Package onion carries Cialai sessions over the plain connections that the Tor
// onion service forwards to the desktop, such as tor.Desktop.Listener. Every
// connection is one mutual TLS 1.3 session with exactly one stream: the phone
// opens a new onion connection per stream and Tor multiplexes them over its
// circuit. Authorization and the restricted pairing entry follow the direct
// transport, so the edge serves both without knowing which one carried a
// stream.
//
// # Control connections
//
// With ListenConfig.Control the listener also offers identity.ControlALPN. A
// connection that negotiates it carries the rendezvous control channel instead
// of an edge stream: Accept never returns it, AcceptControl does, and its
// single stream comes from Session.AcceptControl. Only registered keys open
// one; an unknown, revoked or still pairing key is refused at admission, a
// revocation that races the handshake closes it before the stream is handed
// out, and CloseKey closes it with the edge sessions of the key. A key keeps
// at most MaxControlPerKey control connections, the newest ones.
package onion

import (
	"cmp"
	"context"
	"crypto/tls"
	"errors"
	"net"
	"slices"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const (
	// DefaultHandshakeTimeout bounds the TLS handshake of one onion
	// connection; Tor adds seconds of latency, so it is generous.
	DefaultHandshakeTimeout = 30 * time.Second
	// DefaultMaxHandshakes bounds concurrent handshakes; connections beyond
	// it are closed at once.
	DefaultMaxHandshakes = 32
	// MaxControlPerKey bounds the control connections of one key; a newer
	// one closes the oldest, whose circuit may already be dead.
	MaxControlPerKey     = 2
	defaultGateInterval  = time.Second
	defaultAcceptBacklog = 32
	maxAcceptBackoff     = time.Second
)

// ListenConfig sets the authorization of accepted sessions.
type ListenConfig struct {
	// Registry resolves registered phone keys; nil registers none.
	Registry identity.KeyRegistry
	// Pairing admits unregistered keys while active; nil admits none.
	Pairing transport.PairingGate
	// RestrictedLifetime defaults to transport.RestrictedLifetime.
	RestrictedLifetime time.Duration
	// MaxRestricted defaults to transport.MaxRestrictedSessions.
	MaxRestricted int
	// GateInterval is how often a restricted session rechecks the pairing
	// gate; it defaults to one second.
	GateInterval time.Duration
	// HandshakeTimeout defaults to DefaultHandshakeTimeout.
	HandshakeTimeout time.Duration
	// MaxHandshakes defaults to DefaultMaxHandshakes.
	MaxHandshakes int
	// AcceptBacklog bounds sessions waiting for Accept, and control sessions
	// waiting for AcceptControl; it defaults to 32.
	AcceptBacklog int
	// Control offers identity.ControlALPN and hands the connections that
	// negotiate it to AcceptControl. Without it those handshakes fail.
	Control bool
}

// Listener accepts onion sessions from a plain listener.
type Listener struct {
	raw                net.Listener
	tls                *tls.Config
	registry           identity.KeyRegistry
	pairing            transport.PairingGate
	restrictedLifetime time.Duration
	maxRestricted      int
	gateInterval       time.Duration
	handshakeTimeout   time.Duration
	handshakes         chan struct{}
	accepted           chan *Session
	control            bool
	controls           chan *Session
	ctx                context.Context
	cancel             context.CancelFunc
	closing            chan struct{}
	closeOnce          sync.Once
	closeErr           error
	loopDone           chan struct{}
	handshaking        sync.WaitGroup
	stopped            chan struct{}

	mu         sync.Mutex
	closed     bool
	sessions   map[string]map[*Session]struct{}
	restricted int
	// controlSeq orders the control sessions of a key, oldest first.
	controlSeq uint64
}

var _ transport.Listener = (*Listener)(nil)

var (
	errListenerClosed  = errors.New("onion listener closed")
	errRestrictedFull  = errors.New("restricted sessions full")
	errControlReplaced = errors.New("control connection replaced by a newer one of the same key")
)

// Listen wraps raw with the desktop TLS identity and starts accepting. The
// listener owns raw: Close closes it.
func Listen(raw net.Listener, local *identity.Identity, config ListenConfig) (*Listener, error) {
	if raw == nil {
		return nil, errors.New("onion listener needs the connections forwarded by Tor")
	}
	newConfig := identity.ServerConfig
	if config.Control {
		newConfig = identity.ControlServerConfig
	}
	tlsConfig, err := newConfig(local)
	if err != nil {
		return nil, err
	}
	backlog := positiveOr(config.AcceptBacklog, defaultAcceptBacklog)
	ctx, cancel := context.WithCancel(context.Background())
	listener := &Listener{
		raw:                raw,
		tls:                tlsConfig,
		registry:           config.Registry,
		pairing:            config.Pairing,
		restrictedLifetime: orDefault(config.RestrictedLifetime, transport.RestrictedLifetime),
		maxRestricted:      positiveOr(config.MaxRestricted, transport.MaxRestrictedSessions),
		gateInterval:       orDefault(config.GateInterval, defaultGateInterval),
		handshakeTimeout:   orDefault(config.HandshakeTimeout, DefaultHandshakeTimeout),
		handshakes:         make(chan struct{}, positiveOr(config.MaxHandshakes, DefaultMaxHandshakes)),
		accepted:           make(chan *Session, backlog),
		control:            config.Control,
		controls:           make(chan *Session, backlog),
		ctx:                ctx,
		cancel:             cancel,
		closing:            make(chan struct{}),
		loopDone:           make(chan struct{}),
		stopped:            make(chan struct{}),
		sessions:           make(map[string]map[*Session]struct{}),
	}
	go listener.acceptLoop()
	go func() {
		<-listener.loopDone
		listener.handshaking.Wait()
		close(listener.stopped)
	}()
	return listener, nil
}

// Accept returns the next admitted session. It fails with transport.ErrClosed
// after Close or once the raw listener stopped and every handshake finished.
func (listener *Listener) Accept(ctx context.Context) (transport.Session, error) {
	select {
	case session := <-listener.accepted:
		return session, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-listener.closing:
		return nil, transport.ErrClosed
	case <-listener.stopped:
		select {
		case session := <-listener.accepted:
			return session, nil
		default:
			return nil, transport.ErrClosed
		}
	}
}

// AcceptControl returns the next control session of a registered key. It
// fails with transport.ErrClosed after Close, once the raw listener stopped
// and every handshake finished, or at once when ListenConfig.Control is off.
func (listener *Listener) AcceptControl(ctx context.Context) (transport.ControlSession, error) {
	if !listener.control {
		return nil, transport.ErrClosed
	}
	select {
	case session := <-listener.controls:
		return session, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-listener.closing:
		return nil, transport.ErrClosed
	case <-listener.stopped:
		select {
		case session := <-listener.controls:
			return session, nil
		default:
			return nil, transport.ErrClosed
		}
	}
}

// Addr is the loopback address Tor forwards the onion port to.
func (listener *Listener) Addr() net.Addr { return listener.raw.Addr() }

// Promote lifts the restricted entry from key once the registry knows it.
func (listener *Listener) Promote(key string) int {
	deviceID, ok := listener.registeredKey(key)
	if !ok {
		return 0
	}
	promoted := 0
	for _, session := range listener.sessionsOf(key) {
		if listener.promote(session, deviceID) {
			promoted++
		}
	}
	return promoted
}

// CloseKey closes every session of key, registered or not, without waiting
// for the TLS close alert, as revocation requires.
func (listener *Listener) CloseKey(key string) int {
	closed := 0
	for _, session := range listener.sessionsOf(key) {
		if session.closeWith(transport.ErrRevoked, false) {
			closed++
		}
	}
	return closed
}

// RestrictedSessions reports how many unregistered sessions are alive.
func (listener *Listener) RestrictedSessions() int {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return listener.restricted
}

// Close stops accepting, closes the raw listener and ends every session.
func (listener *Listener) Close() error {
	listener.closeOnce.Do(func() {
		listener.mu.Lock()
		listener.closed = true
		listener.mu.Unlock()
		close(listener.closing)
		listener.cancel()
		if err := listener.raw.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			listener.closeErr = err
		}
		<-listener.stopped
		listener.mu.Lock()
		var sessions []*Session
		for _, set := range listener.sessions {
			for session := range set {
				sessions = append(sessions, session)
			}
		}
		listener.mu.Unlock()
		for _, session := range sessions {
			session.closeWith(transport.ErrClosed, false)
		}
	})
	return listener.closeErr
}

func (listener *Listener) acceptLoop() {
	defer close(listener.loopDone)
	backoff := time.Duration(0)
	for {
		conn, err := listener.raw.Accept()
		if err != nil {
			if listener.ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			// Transient failures such as running out of descriptors.
			backoff = min(max(2*backoff, 5*time.Millisecond), maxAcceptBackoff)
			select {
			case <-time.After(backoff):
				continue
			case <-listener.closing:
				return
			}
		}
		backoff = 0
		select {
		case listener.handshakes <- struct{}{}:
		default:
			_ = conn.Close()
			continue
		}
		listener.handshaking.Add(1)
		go listener.handshake(conn)
	}
}

func (listener *Listener) handshake(raw net.Conn) {
	defer listener.handshaking.Done()
	defer func() { <-listener.handshakes }()
	conn := tls.Server(raw, listener.tls)
	ctx, cancel := context.WithTimeout(listener.ctx, listener.handshakeTimeout)
	err := conn.HandshakeContext(ctx)
	cancel()
	if err != nil {
		_ = raw.Close()
		return
	}
	session := listener.admit(conn, raw)
	if session == nil {
		return
	}
	queue := listener.accepted
	if session.control {
		queue = listener.controls
	}
	select {
	case queue <- session:
	case <-listener.closing:
		session.closeWith(transport.ErrClosed, false)
	}
}

// admit authenticates the peer and applies the restricted entry. It returns
// nil when the connection was refused. TLS carries no application close code,
// so a refused phone only sees the connection end.
func (listener *Listener) admit(conn *tls.Conn, raw net.Conn) *Session {
	peer, err := identity.ServerPeer(conn.ConnectionState(), listener.registry)
	if err != nil {
		_ = raw.Close()
		return nil
	}
	if peer.Control {
		return listener.admitControl(conn, raw, peer)
	}
	session := newSession(listener, conn, raw, peer.Key)
	if peer.Registered {
		session.registered = true
		session.deviceID = peer.DeviceID
		if listener.track(session, false) != nil {
			_ = raw.Close()
			return nil
		}
		// A revocation that raced the handshake removed the key before
		// CloseKey could see this session.
		if _, ok := listener.registeredKey(peer.Key); !ok {
			session.closeWith(transport.ErrRevoked, false)
			return nil
		}
		return session
	}
	if listener.pairing == nil || !listener.pairing.PairingActive() {
		_ = raw.Close()
		return nil
	}
	if listener.track(session, true) != nil {
		_ = raw.Close()
		return nil
	}
	session.armRestricted(listener.restrictedLifetime, listener.gateInterval)
	if deviceID, ok := listener.registeredKey(peer.Key); ok {
		listener.promote(session, deviceID)
	}
	return session
}

// admitControl accepts a control connection only from a registered key; the
// restricted pairing entry never carries one. It returns nil when refused.
func (listener *Listener) admitControl(conn *tls.Conn, raw net.Conn, peer identity.Peer) *Session {
	if !listener.control || !peer.Registered {
		_ = raw.Close()
		return nil
	}
	session := newSession(listener, conn, raw, peer.Key)
	session.control = true
	session.registered = true
	session.deviceID = peer.DeviceID
	if listener.track(session, false) != nil {
		_ = raw.Close()
		return nil
	}
	if _, ok := listener.registeredKey(peer.Key); !ok {
		session.closeWith(transport.ErrRevoked, false)
		return nil
	}
	for _, replaced := range listener.surplusControls(peer.Key) {
		replaced.closeWith(errControlReplaced, false)
	}
	return session
}

// surplusControls returns the oldest control sessions of key beyond
// MaxControlPerKey.
func (listener *Listener) surplusControls(key string) []*Session {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	var controls []*Session
	for session := range listener.sessions[key] {
		if session.control {
			controls = append(controls, session)
		}
	}
	if len(controls) <= MaxControlPerKey {
		return nil
	}
	slices.SortFunc(controls, func(a, b *Session) int { return cmp.Compare(a.controlSeq, b.controlSeq) })
	return controls[:len(controls)-MaxControlPerKey]
}

func (listener *Listener) track(session *Session, restricted bool) error {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	if listener.closed {
		return errListenerClosed
	}
	if restricted {
		if listener.restricted >= listener.maxRestricted {
			return errRestrictedFull
		}
		listener.restricted++
		session.countedRestricted = true
	}
	if session.control {
		listener.controlSeq++
		session.controlSeq = listener.controlSeq
	}
	set := listener.sessions[session.peerKey]
	if set == nil {
		set = make(map[*Session]struct{})
		listener.sessions[session.peerKey] = set
	}
	set[session] = struct{}{}
	return nil
}

func (listener *Listener) untrack(session *Session) {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	if set := listener.sessions[session.peerKey]; set != nil {
		delete(set, session)
		if len(set) == 0 {
			delete(listener.sessions, session.peerKey)
		}
	}
	if session.countedRestricted {
		session.countedRestricted = false
		listener.restricted--
	}
}

func (listener *Listener) sessionsOf(key string) []*Session {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	sessions := make([]*Session, 0, len(listener.sessions[key]))
	for session := range listener.sessions[key] {
		sessions = append(sessions, session)
	}
	return sessions
}

// promote marks a restricted session registered and releases its slot.
func (listener *Listener) promote(session *Session, deviceID string) bool {
	if !session.markRegistered(deviceID) {
		return false
	}
	listener.mu.Lock()
	if session.countedRestricted {
		session.countedRestricted = false
		listener.restricted--
	}
	listener.mu.Unlock()
	return true
}

// admitStream rechecks the key before the stream is handed out. A restricted
// session is promoted or closed by refreshRestricted. A registered session
// whose key left the registry while it waited for Accept was revoked and is
// closed; every later onion connection of the key is refused at admission.
// A stream already handed out is left to CloseKey, so the frames still in
// flight, such as the 4401 close of the bridge, reach the phone.
func (listener *Listener) admitStream(session *Session) bool {
	if !session.Registered() {
		return listener.refreshRestricted(session)
	}
	session.mu.Lock()
	handed := session.handed
	session.mu.Unlock()
	if handed {
		return true
	}
	if _, ok := listener.registeredKey(session.peerKey); ok {
		return true
	}
	session.closeWith(transport.ErrRevoked, false)
	return false
}

// refreshRestricted promotes a restricted session whose registration finished
// and closes it when the pairing gate is no longer active. It reports whether
// the session is alive.
func (listener *Listener) refreshRestricted(session *Session) bool {
	if deviceID, ok := listener.registeredKey(session.peerKey); ok {
		listener.promote(session, deviceID)
		return true
	}
	if listener.pairing == nil || !listener.pairing.PairingActive() {
		session.closeWith(transport.ErrPairingInactive, false)
		return false
	}
	return true
}

func (listener *Listener) registeredKey(key string) (string, bool) {
	if listener.registry == nil {
		return "", false
	}
	return listener.registry.RegisteredKey(key)
}

func orDefault(value, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return value
}

func positiveOr(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}
