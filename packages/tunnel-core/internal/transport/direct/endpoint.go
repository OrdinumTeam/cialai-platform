// SPDX-License-Identifier: Apache-2.0
// Package direct is the direct path of the product: QUIC over one UDP socket
// shared by the listener, the dialer and the NAT puncher, with mutual TLS 1.3
// from the identity package and the restricted pairing entry for keys that are
// not registered yet.
package direct

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

// Default QUIC timings: keepalives every 20 s, aligned with the pings of the
// desktop bridge, keep NAT bindings open, and a failed path is detected after
// 45 s of silence, so a phone suspended or handed off for less than that keeps
// its direct path instead of falling back and climbing again. quic-go caps the
// keepalive at half the idle timeout, so the two values must keep that ratio.
const (
	DefaultKeepAlivePeriod      = 20 * time.Second
	DefaultMaxIdleTimeout       = 45 * time.Second
	DefaultHandshakeIdleTimeout = 5 * time.Second
	DefaultStreamHeaderTimeout  = 5 * time.Second
)

// Config describes an endpoint. The endpoint takes ownership of PacketConn.
type Config struct {
	PacketConn           net.PacketConn
	Identity             *identity.Identity
	KeepAlivePeriod      time.Duration
	MaxIdleTimeout       time.Duration
	HandshakeIdleTimeout time.Duration
	StreamHeaderTimeout  time.Duration
}

// Endpoint owns one UDP socket and the single quic.Transport on top of it.
type Endpoint struct {
	packetConn    net.PacketConn
	quicTransport *quic.Transport
	local         *identity.Identity
	quicConfig    *quic.Config
	headerTimeout time.Duration
	packets       *packetMux
	cancel        context.CancelFunc

	mu         sync.Mutex
	closed     bool
	listener   *Listener
	sessions   map[string]map[*Session]struct{}
	restricted int
}

var (
	_ transport.Dialer  = (*Endpoint)(nil)
	_ transport.Puncher = (*Endpoint)(nil)
)

// New starts an endpoint on config.PacketConn.
func New(config Config) (*Endpoint, error) {
	if config.PacketConn == nil {
		return nil, errors.New("UDP packet connection is required")
	}
	if config.Identity == nil {
		return nil, errors.New("local identity is required")
	}
	quicConfig := &quic.Config{
		HandshakeIdleTimeout:  orDefault(config.HandshakeIdleTimeout, DefaultHandshakeIdleTimeout),
		MaxIdleTimeout:        orDefault(config.MaxIdleTimeout, DefaultMaxIdleTimeout),
		KeepAlivePeriod:       orDefault(config.KeepAlivePeriod, DefaultKeepAlivePeriod),
		MaxIncomingUniStreams: -1,
		Allow0RTT:             false,
	}
	ctx, cancel := context.WithCancel(context.Background())
	quicTransport := &quic.Transport{Conn: config.PacketConn}
	endpoint := &Endpoint{
		packetConn:    config.PacketConn,
		quicTransport: quicTransport,
		local:         config.Identity,
		quicConfig:    quicConfig,
		headerTimeout: orDefault(config.StreamHeaderTimeout, DefaultStreamHeaderTimeout),
		packets:       newPacketMux(quicTransport),
		cancel:        cancel,
		sessions:      make(map[string]map[*Session]struct{}),
	}
	go endpoint.packets.run(ctx)
	return endpoint, nil
}

// LocalAddr is the address of the shared UDP socket.
func (endpoint *Endpoint) LocalAddr() net.Addr { return endpoint.packetConn.LocalAddr() }

// WriteTo sends a raw non-QUIC datagram, such as a STUN request, through the
// shared socket. The first two bits of the packet must be zero.
func (endpoint *Endpoint) WriteTo(packet []byte, to net.Addr) (int, error) {
	return endpoint.quicTransport.WriteTo(packet, to)
}

// HandlePackets receives non-QUIC datagrams that are not opening packets. The
// slice is only valid during the call. A nil handler drops them.
func (endpoint *Endpoint) HandlePackets(handler func(packet []byte, from net.Addr)) {
	endpoint.packets.setHandler(handler)
}

// Dial opens a client session to address pinned to peerKey.
func (endpoint *Endpoint) Dial(ctx context.Context, address string, peerKey ed25519.PublicKey) (transport.Session, error) {
	remote, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", address, err)
	}
	session, err := endpoint.dial(ctx, remote, peerKey)
	if err != nil {
		return nil, err
	}
	return session, nil
}

// DialCandidates dials every candidate at once and keeps the first session.
func (endpoint *Endpoint) DialCandidates(ctx context.Context, candidates []netip.AddrPort, peerKey ed25519.PublicKey) (transport.Session, error) {
	targets := usableCandidates(candidates)
	if len(targets) == 0 {
		return nil, transport.ErrNoCandidates
	}
	type result struct {
		session *Session
		err     error
	}
	dialContext, cancel := context.WithCancel(ctx)
	results := make(chan result, len(targets))
	for _, target := range targets {
		go func() {
			session, err := endpoint.dial(dialContext, net.UDPAddrFromAddrPort(target), peerKey)
			if err != nil {
				err = fmt.Errorf("%s: %w", target, err)
			}
			results <- result{session: session, err: err}
		}()
	}
	var failures []error
	for received := 1; received <= len(targets); received++ {
		outcome := <-results
		if outcome.err != nil {
			failures = append(failures, outcome.err)
			continue
		}
		cancel()
		// Losing dials may still complete; close them in the background.
		go func(remaining int) {
			for range remaining {
				if late := <-results; late.session != nil {
					_ = late.session.closeWith(codeNormal, "duplicate candidate")
				}
			}
		}(len(targets) - received)
		return outcome.session, nil
	}
	cancel()
	return nil, errors.Join(failures...)
}

// Punch sends opening packets to candidates and waits for their answers.
func (endpoint *Endpoint) Punch(ctx context.Context, candidates []netip.AddrPort) (transport.PunchReport, error) {
	if endpoint.isClosed() {
		return transport.PunchReport{}, transport.ErrClosed
	}
	targets := usableCandidates(candidates)
	if len(targets) == 0 {
		return transport.PunchReport{}, transport.ErrNoCandidates
	}
	return endpoint.packets.punch(ctx, targets)
}

// Listen starts accepting sessions on the shared socket. Only one listener
// may exist per endpoint at a time; a new one may start after Close.
func (endpoint *Endpoint) Listen(config ListenConfig) (*Listener, error) {
	serverTLS, err := identity.ServerConfig(endpoint.local)
	if err != nil {
		return nil, err
	}
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	if endpoint.closed {
		return nil, transport.ErrClosed
	}
	if endpoint.listener != nil {
		return nil, errors.New("endpoint already has a listener")
	}
	quicListener, err := endpoint.quicTransport.Listen(serverTLS, endpoint.quicConfig.Clone())
	if err != nil {
		return nil, fmt.Errorf("listen QUIC: %w", err)
	}
	listener := newListener(endpoint, quicListener, config)
	endpoint.listener = listener
	go listener.acceptLoop()
	return listener, nil
}

// CloseKey closes every session of key on this endpoint, dialed or accepted.
func (endpoint *Endpoint) CloseKey(key string) int {
	sessions := endpoint.sessionsOf(key)
	for _, session := range sessions {
		_ = session.closeWith(codeRevoked, "device key revoked")
	}
	return len(sessions)
}

// Close ends every session, the listener and the socket.
func (endpoint *Endpoint) Close() error {
	endpoint.mu.Lock()
	if endpoint.closed {
		endpoint.mu.Unlock()
		return nil
	}
	endpoint.closed = true
	listener := endpoint.listener
	var sessions []*Session
	for _, set := range endpoint.sessions {
		for session := range set {
			sessions = append(sessions, session)
		}
	}
	endpoint.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	closeSessions(sessions, codeClosing, "endpoint closed")
	endpoint.cancel()
	transportErr := endpoint.quicTransport.Close()
	packetErr := endpoint.packetConn.Close()
	return errors.Join(transportErr, packetErr)
}

func (endpoint *Endpoint) dial(ctx context.Context, remote *net.UDPAddr, peerKey ed25519.PublicKey) (*Session, error) {
	if endpoint.isClosed() {
		return nil, transport.ErrClosed
	}
	clientTLS, err := identity.ClientConfig(endpoint.local, peerKey)
	if err != nil {
		return nil, err
	}
	conn, err := endpoint.quicTransport.Dial(ctx, remote, clientTLS, endpoint.quicConfig.Clone())
	if err != nil {
		return nil, fmt.Errorf("dial QUIC %s: %w", remote, mapError(err))
	}
	public, err := identity.PeerPublicKey(conn.ConnectionState().TLS)
	if err != nil {
		_ = conn.CloseWithError(codePeerInvalid, "invalid peer")
		return nil, fmt.Errorf("%w: %w", transport.ErrPeerInvalid, err)
	}
	session := newSession(endpoint, conn, identity.EncodePublicKey(public), nil)
	session.registered = true
	session.localAddr = endpoint.packetConn.LocalAddr()
	session.remoteAddr = remote
	if !endpoint.track(session) {
		_ = conn.CloseWithError(codeClosing, "endpoint closed")
		return nil, transport.ErrClosed
	}
	go session.run()
	return session, nil
}

func (endpoint *Endpoint) isClosed() bool {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return endpoint.closed
}

// track indexes a live session by key; it fails once the endpoint is closed.
func (endpoint *Endpoint) track(session *Session) bool {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	if endpoint.closed {
		return false
	}
	set := endpoint.sessions[session.peerKey]
	if set == nil {
		set = make(map[*Session]struct{})
		endpoint.sessions[session.peerKey] = set
	}
	set[session] = struct{}{}
	return true
}

func (endpoint *Endpoint) untrack(session *Session) {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	set := endpoint.sessions[session.peerKey]
	if _, ok := set[session]; !ok {
		return
	}
	delete(set, session)
	if len(set) == 0 {
		delete(endpoint.sessions, session.peerKey)
	}
	if session.countedRestricted {
		session.countedRestricted = false
		endpoint.restricted--
	}
}

func (endpoint *Endpoint) sessionsOf(key string) []*Session {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	sessions := make([]*Session, 0, len(endpoint.sessions[key]))
	for session := range endpoint.sessions[key] {
		sessions = append(sessions, session)
	}
	return sessions
}

func closeSessions(sessions []*Session, code quic.ApplicationErrorCode, reason string) {
	var wait sync.WaitGroup
	for _, session := range sessions {
		wait.Go(func() { _ = session.closeWith(code, reason) })
	}
	wait.Wait()
}

func usableCandidates(candidates []netip.AddrPort) []netip.AddrPort {
	seen := make(map[netip.AddrPort]bool, len(candidates))
	targets := make([]netip.AddrPort, 0, len(candidates))
	for _, candidate := range candidates {
		candidate = netip.AddrPortFrom(candidate.Addr().Unmap(), candidate.Port())
		if !candidate.IsValid() || candidate.Port() == 0 || candidate.Addr().IsUnspecified() || seen[candidate] {
			continue
		}
		seen[candidate] = true
		targets = append(targets, candidate)
	}
	return targets
}

func orDefault(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
