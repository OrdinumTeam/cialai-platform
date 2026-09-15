// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

// Every stream starts with one byte naming its kind, written by the opener.
const (
	streamKindControl byte = 'C'
	streamKindData    byte = 'D'
	dataBacklog            = 8
)

var errNotDialer = errors.New("only the dialing side opens the control stream")

// Session is a QUIC connection to an authenticated peer.
type Session struct {
	endpoint *Endpoint
	conn     *quic.Conn
	peerKey  string
	listener *Listener // nil on the dialing side
	data     chan *stream
	control  chan *stream

	// countedRestricted is guarded by endpoint.mu.
	countedRestricted bool

	mu           sync.Mutex
	registered   bool
	deviceID     string
	dataStreams  int
	controlUsed  bool
	timer        *time.Timer
	deadline     time.Time
	gateInterval time.Duration
	gateMisses   int
	migrations   []migration
	finished     bool
	// Dialing side only: quic-go swaps its path without locking after a
	// migration, so the session reports the addresses it chose itself.
	localAddr  net.Addr
	remoteAddr net.Addr
}

type migration struct {
	transport  *quic.Transport
	packetConn net.PacketConn
}

var _ transport.ControlSession = (*Session)(nil)

func newSession(endpoint *Endpoint, conn *quic.Conn, peerKey string, listener *Listener) *Session {
	return &Session{
		endpoint: endpoint,
		conn:     conn,
		peerKey:  peerKey,
		listener: listener,
		data:     make(chan *stream, dataBacklog),
		control:  make(chan *stream, 1),
	}
}

func (session *Session) PeerKey() string   { return session.peerKey }
func (session *Session) Transport() string { return transport.NameDirect }

// LocalAddr is the socket currently carrying the session.
func (session *Session) LocalAddr() net.Addr {
	if session.listener != nil {
		return session.conn.LocalAddr()
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.localAddr
}

// RemoteAddr is the peer address; on the accepting side it follows the
// client migration.
func (session *Session) RemoteAddr() net.Addr {
	if session.listener != nil {
		return session.conn.RemoteAddr()
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.remoteAddr
}

func (session *Session) Done() <-chan struct{} {
	return session.conn.Context().Done()
}

// Registered is false while an accepted session is limited to pairing.
func (session *Session) Registered() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.registered
}

// DeviceID is the registry id of an accepted registered session.
func (session *Session) DeviceID() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.deviceID
}

// Err explains why the session ended, or returns nil while it is alive.
func (session *Session) Err() error {
	ctx := session.conn.Context()
	if ctx.Err() == nil {
		return nil
	}
	return sessionError(ctx)
}

// Close ends the session normally.
func (session *Session) Close() error {
	return session.closeWith(codeNormal, "closed")
}

// OpenStream opens a data stream. An accepted session never opens streams
// towards a restricted peer.
func (session *Session) OpenStream(ctx context.Context) (transport.Stream, error) {
	if session.listener != nil && !session.Registered() {
		return nil, transport.ErrStreamRefused
	}
	return session.open(ctx, streamKindData)
}

// AcceptStream returns the next data stream opened by the peer.
func (session *Session) AcceptStream(ctx context.Context) (transport.Stream, error) {
	select {
	case incoming := <-session.data:
		return incoming, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-session.Done():
		return nil, sessionError(session.conn.Context())
	}
}

// OpenControl opens the single control stream; only the dialing side may.
func (session *Session) OpenControl(ctx context.Context) (transport.Stream, error) {
	if session.listener != nil {
		return nil, errNotDialer
	}
	session.mu.Lock()
	if session.controlUsed {
		session.mu.Unlock()
		return nil, errors.New("control stream already opened")
	}
	session.controlUsed = true
	session.mu.Unlock()
	opened, err := session.open(ctx, streamKindControl)
	if err != nil {
		session.mu.Lock()
		session.controlUsed = false
		session.mu.Unlock()
	}
	return opened, err
}

// AcceptControl returns the control stream opened by the dialing side.
func (session *Session) AcceptControl(ctx context.Context) (transport.Stream, error) {
	if session.listener == nil {
		return nil, errNotDialer
	}
	select {
	case incoming := <-session.control:
		return incoming, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-session.Done():
		return nil, sessionError(session.conn.Context())
	}
}

// Migrate moves a dialed session to packetConn with QUIC path validation,
// for example after a Wi-Fi to mobile network change. On success the session
// owns packetConn and closes it when it ends; on failure the caller keeps it.
func (session *Session) Migrate(ctx context.Context, packetConn net.PacketConn) error {
	if session.listener != nil {
		return errors.New("only the dialing side migrates")
	}
	if packetConn == nil {
		return errors.New("UDP packet connection is required")
	}
	pathTransport := &quic.Transport{Conn: packetConn}
	path, err := session.conn.AddPath(pathTransport)
	if err != nil {
		_ = pathTransport.Close()
		return err
	}
	if err := path.Probe(ctx); err != nil {
		_ = path.Close()
		_ = pathTransport.Close()
		return mapError(err)
	}
	if err := path.Switch(); err != nil {
		_ = path.Close()
		_ = pathTransport.Close()
		return mapError(err)
	}
	session.mu.Lock()
	if session.finished {
		session.mu.Unlock()
		_ = pathTransport.Close()
		_ = packetConn.Close()
		return transport.ErrClosed
	}
	// Old path transports stay open: closing a quic.Transport destroys every
	// connection registered on it, this one included.
	session.migrations = append(session.migrations, migration{transport: pathTransport, packetConn: packetConn})
	session.localAddr = packetConn.LocalAddr()
	session.mu.Unlock()
	return nil
}

func (session *Session) open(ctx context.Context, kind byte) (*stream, error) {
	quicStream, err := session.conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, session.openError(err)
	}
	if _, err := quicStream.Write([]byte{kind}); err != nil {
		quicStream.CancelRead(streamCodeClosed)
		quicStream.CancelWrite(streamCodeClosed)
		return nil, session.openError(err)
	}
	return newStream(session, quicStream), nil
}

func (session *Session) openError(err error) error {
	if session.conn.Context().Err() != nil {
		return sessionError(session.conn.Context())
	}
	return mapError(err)
}

func (session *Session) run() {
	defer session.finish()
	ctx := session.conn.Context()
	for {
		quicStream, err := session.conn.AcceptStream(ctx)
		if err != nil {
			return
		}
		session.dispatch(ctx, quicStream)
	}
}

func (session *Session) dispatch(ctx context.Context, quicStream *quic.Stream) {
	kind, err := readStreamKind(quicStream, session.endpoint.headerTimeout)
	if err != nil {
		refuseStream(quicStream)
		return
	}
	switch kind {
	case streamKindControl:
		if !session.admitControl() {
			refuseStream(quicStream)
			return
		}
		session.control <- newStream(session, quicStream)
	case streamKindData:
		if !session.admitData() {
			refuseStream(quicStream)
			return
		}
		select {
		case session.data <- newStream(session, quicStream):
		case <-ctx.Done():
			refuseStream(quicStream)
		}
	default:
		refuseStream(quicStream)
	}
}

// admitControl allows one control stream from the dialing side of a
// registered session whose key is still registered.
func (session *Session) admitControl() bool {
	if session.listener == nil || !session.listener.admitStream(session) {
		return false
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if !session.registered || session.controlUsed {
		return false
	}
	session.controlUsed = true
	return true
}

// admitData allows a single data stream while the session is restricted and
// none once the key of an accepted session was revoked.
func (session *Session) admitData() bool {
	if session.listener != nil && !session.listener.admitStream(session) {
		return false
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.registered {
		return true
	}
	if session.dataStreams >= 1 {
		return false
	}
	session.dataStreams++
	return true
}

// armRestricted closes the session at the lifetime deadline or once the
// pairing gate stays inactive for two consecutive checks. The second check
// leaves room for the registry write that follows a consumed pairing.
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
		_ = session.closeWith(codeRestrictedExpired, "pairing session expired")
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
		_ = session.closeWith(codePairingInactive, "pairing is not active")
		return
	}
	session.timer.Reset(min(session.gateInterval, remaining))
	session.mu.Unlock()
}

func (session *Session) markRegistered(deviceID string) bool {
	if session.conn.Context().Err() != nil {
		return false
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.registered {
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

func (session *Session) closeWith(code quic.ApplicationErrorCode, reason string) error {
	session.mu.Lock()
	session.stopTimerLocked()
	session.mu.Unlock()
	err := session.conn.CloseWithError(code, reason)
	session.endpoint.untrack(session)
	return err
}

func (session *Session) finish() {
	session.mu.Lock()
	session.finished = true
	session.stopTimerLocked()
	migrations := session.migrations
	session.migrations = nil
	session.mu.Unlock()
	session.endpoint.untrack(session)
	for _, moved := range migrations {
		_ = moved.transport.Close()
		_ = moved.packetConn.Close()
	}
}

func readStreamKind(quicStream *quic.Stream, timeout time.Duration) (byte, error) {
	_ = quicStream.SetReadDeadline(time.Now().Add(timeout))
	var header [1]byte
	if _, err := io.ReadFull(quicStream, header[:]); err != nil {
		return 0, err
	}
	_ = quicStream.SetReadDeadline(time.Time{})
	return header[0], nil
}

func refuseStream(quicStream *quic.Stream) {
	quicStream.CancelRead(streamCodeRefused)
	quicStream.CancelWrite(streamCodeRefused)
}
