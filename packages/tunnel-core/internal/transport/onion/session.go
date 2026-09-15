// SPDX-License-Identifier: Apache-2.0
package onion

import (
	"context"
	"crypto/tls"
	"net"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// Session is one TLS connection forwarded by the onion service. It carries a
// single stream, handed out once by AcceptStream.
type Session struct {
	listener *Listener
	conn     *tls.Conn
	raw      net.Conn
	peerKey  string
	stream   *stream
	done     chan struct{}
	once     sync.Once

	// countedRestricted is guarded by listener.mu.
	countedRestricted bool

	mu           sync.Mutex
	registered   bool
	deviceID     string
	handed       bool
	err          error
	timer        *time.Timer
	deadline     time.Time
	gateInterval time.Duration
	gateMisses   int
}

var _ transport.Session = (*Session)(nil)

func newSession(listener *Listener, conn *tls.Conn, raw net.Conn, peerKey string) *Session {
	session := &Session{listener: listener, conn: conn, raw: raw, peerKey: peerKey, done: make(chan struct{})}
	session.stream = &stream{session: session}
	return session
}

func (session *Session) PeerKey() string      { return session.peerKey }
func (session *Session) Transport() string    { return transport.NameTor }
func (session *Session) LocalAddr() net.Addr  { return session.raw.LocalAddr() }
func (session *Session) RemoteAddr() net.Addr { return session.raw.RemoteAddr() }

// Done is closed when the session ends for any reason.
func (session *Session) Done() <-chan struct{} { return session.done }

// Registered is false while the session is limited to pairing.
func (session *Session) Registered() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.registered
}

// DeviceID is the registry id of a registered session.
func (session *Session) DeviceID() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.deviceID
}

// Err explains why the session ended, or returns nil while it is alive.
func (session *Session) Err() error {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.err
}

// OpenStream is refused: the desktop never opens streams over an onion
// connection, the phone opens one connection per stream.
func (session *Session) OpenStream(context.Context) (transport.Stream, error) {
	return nil, transport.ErrStreamRefused
}

// AcceptStream returns the single stream of the session, then waits until the
// session ends. A restricted session rechecks the pairing gate first and a
// registered one checks that its key was not revoked since the handshake.
func (session *Session) AcceptStream(ctx context.Context) (transport.Stream, error) {
	if !session.listener.admitStream(session) {
		return nil, session.endError()
	}
	session.mu.Lock()
	alive := session.err == nil
	first := alive && !session.handed
	session.handed = session.handed || first
	session.mu.Unlock()
	if first {
		return session.stream, nil
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-session.done:
		return nil, session.endError()
	}
}

// Close ends the session normally, sending the TLS close alert.
func (session *Session) Close() error {
	session.closeWith(transport.ErrClosed, true)
	return nil
}

func (session *Session) endError() error {
	if err := session.Err(); err != nil {
		return err
	}
	return transport.ErrClosed
}

// closeWith ends the session with reason and reports whether this call ended
// it. A forced close drops the connection without the TLS alert, so it never
// waits on a stalled peer; it also cuts a graceful close still in progress.
func (session *Session) closeWith(reason error, graceful bool) bool {
	first := false
	session.once.Do(func() {
		first = true
		session.mu.Lock()
		session.err = reason
		session.stopTimerLocked()
		session.mu.Unlock()
		session.listener.untrack(session)
		close(session.done)
	})
	if graceful && first {
		_ = session.conn.Close()
	} else {
		_ = session.raw.Close()
	}
	return first
}

// armRestricted closes the session at the lifetime deadline or once the
// pairing gate stays inactive for two consecutive checks, like the direct
// transport. The second check leaves room for the registry write that follows
// a consumed pairing.
func (session *Session) armRestricted(lifetime, interval time.Duration) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.registered {
		return
	}
	session.deadline = time.Now().Add(lifetime)
	session.gateInterval = interval
	session.timer = time.AfterFunc(min(interval, lifetime), session.checkRestricted)
}

func (session *Session) checkRestricted() {
	session.mu.Lock()
	if session.registered || session.timer == nil {
		session.mu.Unlock()
		return
	}
	remaining := time.Until(session.deadline)
	session.mu.Unlock()

	listener := session.listener
	if deviceID, ok := listener.registeredKey(session.peerKey); ok {
		listener.promote(session, deviceID)
		return
	}
	if remaining <= 0 {
		session.closeWith(transport.ErrRestrictedExpired, false)
		return
	}
	gateOpen := listener.pairing != nil && listener.pairing.PairingActive()

	session.mu.Lock()
	if session.registered || session.timer == nil {
		session.mu.Unlock()
		return
	}
	if gateOpen {
		session.gateMisses = 0
	} else {
		session.gateMisses++
	}
	if session.gateMisses >= 2 {
		session.mu.Unlock()
		session.closeWith(transport.ErrPairingInactive, false)
		return
	}
	session.timer.Reset(min(session.gateInterval, remaining))
	session.mu.Unlock()
}

func (session *Session) markRegistered(deviceID string) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.registered || session.err != nil {
		return false
	}
	session.registered = true
	session.deviceID = deviceID
	session.stopTimerLocked()
	return true
}

func (session *Session) stopTimerLocked() {
	if session.timer != nil {
		session.timer.Stop()
		session.timer = nil
	}
}

// stream is the single net.Conn of a session. Closing it ends the session.
type stream struct {
	session *Session
}

var _ transport.Stream = (*stream)(nil)

func (conn *stream) Read(buffer []byte) (int, error)  { return conn.session.conn.Read(buffer) }
func (conn *stream) Write(buffer []byte) (int, error) { return conn.session.conn.Write(buffer) }
func (conn *stream) Close() error                     { return conn.session.Close() }

// CloseWrite sends the TLS close alert while the read direction stays open.
func (conn *stream) CloseWrite() error          { return conn.session.conn.CloseWrite() }
func (conn *stream) Session() transport.Session { return conn.session }
func (conn *stream) LocalAddr() net.Addr        { return conn.session.LocalAddr() }
func (conn *stream) RemoteAddr() net.Addr       { return conn.session.RemoteAddr() }
func (conn *stream) SetDeadline(deadline time.Time) error {
	return conn.session.conn.SetDeadline(deadline)
}
func (conn *stream) SetReadDeadline(deadline time.Time) error {
	return conn.session.conn.SetReadDeadline(deadline)
}
func (conn *stream) SetWriteDeadline(deadline time.Time) error {
	return conn.session.conn.SetWriteDeadline(deadline)
}
