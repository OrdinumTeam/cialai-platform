// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

const (
	defaultGateInterval  = time.Second
	defaultAcceptBacklog = 32
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
	// AcceptBacklog bounds sessions waiting for Accept; it defaults to 32.
	AcceptBacklog int
}

// Listener accepts direct sessions on the endpoint socket.
type Listener struct {
	endpoint           *Endpoint
	quic               *quic.Listener
	registry           identity.KeyRegistry
	pairing            transport.PairingGate
	restrictedLifetime time.Duration
	maxRestricted      int
	gateInterval       time.Duration
	accepted           chan *Session
	closing            chan struct{}
	closeOnce          sync.Once
	loopDone           chan struct{}
}

var _ transport.Listener = (*Listener)(nil)

func newListener(endpoint *Endpoint, quicListener *quic.Listener, config ListenConfig) *Listener {
	maxRestricted := config.MaxRestricted
	if maxRestricted <= 0 {
		maxRestricted = transport.MaxRestrictedSessions
	}
	backlog := config.AcceptBacklog
	if backlog <= 0 {
		backlog = defaultAcceptBacklog
	}
	return &Listener{
		endpoint:           endpoint,
		quic:               quicListener,
		registry:           config.Registry,
		pairing:            config.Pairing,
		restrictedLifetime: orDefault(config.RestrictedLifetime, transport.RestrictedLifetime),
		maxRestricted:      maxRestricted,
		gateInterval:       orDefault(config.GateInterval, defaultGateInterval),
		accepted:           make(chan *Session, backlog),
		closing:            make(chan struct{}),
		loopDone:           make(chan struct{}),
	}
}

// Accept returns the next admitted session.
func (listener *Listener) Accept(ctx context.Context) (transport.Session, error) {
	select {
	case session := <-listener.accepted:
		return session, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-listener.closing:
		return nil, transport.ErrClosed
	}
}

// Addr is the shared UDP socket address.
func (listener *Listener) Addr() net.Addr { return listener.quic.Addr() }

// Promote lifts the restricted entry from key once the registry knows it.
func (listener *Listener) Promote(key string) int {
	deviceID, ok := listener.registeredKey(key)
	if !ok {
		return 0
	}
	promoted := 0
	for _, session := range listener.endpoint.sessionsOf(key) {
		if session.listener == listener && listener.promote(session, deviceID) {
			promoted++
		}
	}
	return promoted
}

// CloseKey closes every session of key, registered or not.
func (listener *Listener) CloseKey(key string) int {
	closed := 0
	for _, session := range listener.endpoint.sessionsOf(key) {
		if session.listener == listener {
			_ = session.closeWith(codeRevoked, "device key revoked")
			closed++
		}
	}
	return closed
}

// RestrictedSessions reports how many unregistered sessions are alive.
func (listener *Listener) RestrictedSessions() int {
	listener.endpoint.mu.Lock()
	defer listener.endpoint.mu.Unlock()
	return listener.endpoint.restricted
}

// Close stops accepting and ends the sessions accepted by this listener.
func (listener *Listener) Close() error {
	var err error
	listener.closeOnce.Do(func() {
		close(listener.closing)
		err = listener.quic.Close()
		<-listener.loopDone
		var sessions []*Session
		listener.endpoint.mu.Lock()
		if listener.endpoint.listener == listener {
			listener.endpoint.listener = nil
		}
		for _, set := range listener.endpoint.sessions {
			for session := range set {
				if session.listener == listener {
					sessions = append(sessions, session)
				}
			}
		}
		listener.endpoint.mu.Unlock()
		closeSessions(sessions, codeClosing, "listener closed")
		if errors.Is(err, quic.ErrServerClosed) {
			err = nil
		}
	})
	return err
}

func (listener *Listener) acceptLoop() {
	defer close(listener.loopDone)
	for {
		// Accept drains the queue after Close and then fails, so queued
		// connections are refused instead of leaked.
		conn, err := listener.quic.Accept(context.Background())
		if err != nil {
			return
		}
		select {
		case <-listener.closing:
			_ = conn.CloseWithError(codeClosing, "listener closed")
			continue
		default:
		}
		session := listener.admit(conn)
		if session == nil {
			continue
		}
		select {
		case listener.accepted <- session:
		case <-listener.closing:
			_ = session.closeWith(codeClosing, "listener closed")
		}
	}
}

// admit authenticates the peer and applies the restricted entry. It returns
// nil when the connection was refused.
func (listener *Listener) admit(conn *quic.Conn) *Session {
	peer, err := identity.ServerPeer(conn.ConnectionState().TLS, listener.registry)
	if err != nil {
		_ = conn.CloseWithError(codePeerInvalid, "invalid peer certificate")
		return nil
	}
	session := newSession(listener.endpoint, conn, peer.Key, listener)
	if peer.Registered {
		session.registered = true
		session.deviceID = peer.DeviceID
		if !listener.endpoint.track(session) {
			_ = conn.CloseWithError(codeClosing, "endpoint closed")
			return nil
		}
		// A revocation that raced the handshake removed the key before
		// CloseKey could see this session.
		if _, ok := listener.registeredKey(peer.Key); !ok {
			_ = session.closeWith(codeRevoked, "device key revoked")
			return nil
		}
	} else {
		if listener.pairing == nil || !listener.pairing.PairingActive() {
			_ = conn.CloseWithError(codePairingInactive, "pairing is not active")
			return nil
		}
		switch listener.trackRestricted(session) {
		case errClosedEndpoint:
			_ = conn.CloseWithError(codeClosing, "endpoint closed")
			return nil
		case errRestrictedFull:
			_ = conn.CloseWithError(codeRestrictedLimit, "too many pairing sessions")
			return nil
		}
		session.armRestricted(listener.restrictedLifetime, listener.gateInterval)
		if deviceID, ok := listener.registeredKey(peer.Key); ok {
			listener.promote(session, deviceID)
		}
	}
	go session.run()
	return session
}

var (
	errClosedEndpoint = errors.New("endpoint closed")
	errRestrictedFull = errors.New("restricted sessions full")
)

func (listener *Listener) trackRestricted(session *Session) error {
	endpoint := listener.endpoint
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	if endpoint.closed {
		return errClosedEndpoint
	}
	if endpoint.restricted >= listener.maxRestricted {
		return errRestrictedFull
	}
	endpoint.restricted++
	session.countedRestricted = true
	set := endpoint.sessions[session.peerKey]
	if set == nil {
		set = make(map[*Session]struct{})
		endpoint.sessions[session.peerKey] = set
	}
	set[session] = struct{}{}
	return nil
}

// promote marks a restricted session registered and releases its slot.
func (listener *Listener) promote(session *Session, deviceID string) bool {
	if !session.markRegistered(deviceID) {
		return false
	}
	endpoint := listener.endpoint
	endpoint.mu.Lock()
	if session.countedRestricted {
		session.countedRestricted = false
		endpoint.restricted--
	}
	endpoint.mu.Unlock()
	return true
}

// refreshRestricted is called when a restricted session receives a stream:
// it promotes the session if registration finished and closes it when the
// pairing gate is no longer active. It reports whether the session is alive.
func (listener *Listener) refreshRestricted(session *Session) bool {
	if deviceID, ok := listener.registeredKey(session.peerKey); ok {
		listener.promote(session, deviceID)
		return true
	}
	if listener.pairing == nil || !listener.pairing.PairingActive() {
		_ = session.closeWith(codePairingInactive, "pairing is not active")
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
