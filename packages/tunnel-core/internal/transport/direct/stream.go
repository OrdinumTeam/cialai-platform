// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"net"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

// stream adapts a bidirectional QUIC stream to net.Conn. Close ends both
// directions; CloseWrite only sends FIN, like TCP half-close.
type stream struct {
	quic      *quic.Stream
	session   *Session
	closeOnce sync.Once
}

var _ transport.Stream = (*stream)(nil)

func newStream(session *Session, quicStream *quic.Stream) *stream {
	return &stream{quic: quicStream, session: session}
}

func (conn *stream) Read(buffer []byte) (int, error) {
	n, err := conn.quic.Read(buffer)
	return n, mapError(err)
}

func (conn *stream) Write(buffer []byte) (int, error) {
	n, err := conn.quic.Write(buffer)
	return n, mapError(err)
}

// Close sends FIN and stops reading, so a blocked Read returns at once.
func (conn *stream) Close() error {
	err := net.ErrClosed
	conn.closeOnce.Do(func() {
		conn.quic.CancelRead(streamCodeClosed)
		err = conn.quic.Close()
	})
	return err
}

// CloseWrite sends FIN while the read direction stays open.
func (conn *stream) CloseWrite() error { return conn.quic.Close() }

func (conn *stream) Session() transport.Session           { return conn.session }
func (conn *stream) LocalAddr() net.Addr                  { return conn.session.LocalAddr() }
func (conn *stream) RemoteAddr() net.Addr                 { return conn.session.RemoteAddr() }
func (conn *stream) SetDeadline(deadline time.Time) error { return conn.quic.SetDeadline(deadline) }
func (conn *stream) SetReadDeadline(deadline time.Time) error {
	return conn.quic.SetReadDeadline(deadline)
}
func (conn *stream) SetWriteDeadline(deadline time.Time) error {
	return conn.quic.SetWriteDeadline(deadline)
}
