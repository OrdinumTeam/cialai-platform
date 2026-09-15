// SPDX-License-Identifier: Apache-2.0
// Package transport holds the contracts shared by every Cialai transport: the
// direct QUIC path and, later, the Tor fallback. A session is authenticated by
// mutual TLS and keyed by the peer Ed25519 key; its streams are net.Conn values
// the edge can serve without knowing which transport carried them.
package transport

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net"
	"net/netip"
	"time"
)

// Transport names reported by Session.Transport.
const (
	NameDirect = "direct"
	NameTor    = "tor"
)

// Restricted pairing entry limits shared by every transport. A session whose
// key is not registered only exists while a pairing session is active, lives
// at most RestrictedLifetime, has no control stream and a single data stream.
const (
	RestrictedLifetime    = 60 * time.Second
	MaxRestrictedSessions = 4
)

var (
	ErrClosed            = errors.New("transport closed")
	ErrPeerInvalid       = errors.New("peer did not present a valid Ed25519 certificate")
	ErrPairingInactive   = errors.New("unregistered key refused: no pairing session is active")
	ErrRestrictedLimit   = errors.New("unregistered key refused: too many pairing sessions")
	ErrRestrictedExpired = errors.New("unregistered session expired before registration")
	ErrRevoked           = errors.New("session closed: device key revoked")
	ErrStreamRefused     = errors.New("stream refused by the peer")
	ErrNoCandidates      = errors.New("no usable candidate")
)

// PairingGate reports whether a pairing session is active. The pairing
// package implements it; transports only consume it.
type PairingGate interface {
	PairingActive() bool
}

// Session is one authenticated connection to a peer.
type Session interface {
	// PeerKey is the canonical base64url Ed25519 key proven by the handshake.
	PeerKey() string
	// Transport names the carrier, such as NameDirect or NameTor.
	Transport() string
	// Registered is false while the session is limited to the pairing entry.
	// The dialing side pins the peer key and always reports true.
	Registered() bool
	OpenStream(ctx context.Context) (Stream, error)
	AcceptStream(ctx context.Context) (Stream, error)
	LocalAddr() net.Addr
	RemoteAddr() net.Addr
	// Done is closed when the session ends for any reason.
	Done() <-chan struct{}
	Close() error
}

// ControlSession is implemented by transports that carry one control stream
// beside the data streams. Only the dialing side opens it and restricted
// sessions never get one.
type ControlSession interface {
	Session
	OpenControl(ctx context.Context) (Stream, error)
	AcceptControl(ctx context.Context) (Stream, error)
}

// Stream is a bidirectional byte stream bound to its session.
type Stream interface {
	net.Conn
	Session() Session
}

// Listener accepts sessions and applies the restricted pairing entry.
type Listener interface {
	Accept(ctx context.Context) (Session, error)
	Addr() net.Addr
	// Promote lifts the restricted entry from the sessions of key once the
	// key registry knows it, returning how many sessions were promoted.
	Promote(key string) int
	// CloseKey closes every session of key, as required by revocation,
	// returning how many sessions were closed.
	CloseKey(key string) int
	Close() error
}

// Dialer opens a session to address, accepting only the pinned peer key.
type Dialer interface {
	Dial(ctx context.Context, address string, peerKey ed25519.PublicKey) (Session, error)
}

// PunchReport summarizes one round of opening packets.
type PunchReport struct {
	// Sent counts opening packets written, retransmissions included.
	Sent int
	// Acknowledged lists the candidates that answered, in answer order.
	Acknowledged []netip.AddrPort
}

// Puncher opens NAT bindings and dials candidates through the socket shared
// with the listener, so a later implementation such as pion ICE can replace
// the built-in one without touching candidates or rendezvous.
type Puncher interface {
	Punch(ctx context.Context, candidates []netip.AddrPort) (PunchReport, error)
	DialCandidates(ctx context.Context, candidates []netip.AddrPort, peerKey ed25519.PublicKey) (Session, error)
}
