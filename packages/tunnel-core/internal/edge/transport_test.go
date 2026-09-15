// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"context"
	"net"
	"sync"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// fakeListener is an authenticated transport without sockets or TLS: each
// session carries the key its handshake would have proven, and each stream is
// one side of a net.Pipe. Promote and CloseKey follow the real listeners.
type fakeListener struct {
	registry identity.KeyRegistry
	queue    chan *fakeSession
	closing  chan struct{}
	once     sync.Once

	mu       sync.Mutex
	sessions []*fakeSession
	closed   []string
}

var _ transport.Listener = (*fakeListener)(nil)

func newFakeListener(registry identity.KeyRegistry) *fakeListener {
	return &fakeListener{registry: registry, queue: make(chan *fakeSession, 16), closing: make(chan struct{})}
}

func (listener *fakeListener) Accept(ctx context.Context) (transport.Session, error) {
	select {
	case session := <-listener.queue:
		return session, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-listener.closing:
		return nil, transport.ErrClosed
	}
}

func (listener *fakeListener) Addr() net.Addr {
	return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 4740}
}

func (listener *fakeListener) Promote(key string) int {
	if _, ok := listener.registry.RegisteredKey(key); !ok {
		return 0
	}
	promoted := 0
	for _, session := range listener.sessionsOf(key) {
		session.mu.Lock()
		if !session.registered && !session.closedLocked() {
			session.registered = true
			promoted++
		}
		session.mu.Unlock()
	}
	return promoted
}

func (listener *fakeListener) CloseKey(key string) int {
	listener.mu.Lock()
	listener.closed = append(listener.closed, key)
	listener.mu.Unlock()
	closed := 0
	for _, session := range listener.sessionsOf(key) {
		if session.closeSession() {
			closed++
		}
	}
	return closed
}

func (listener *fakeListener) Close() error {
	listener.once.Do(func() { close(listener.closing) })
	listener.mu.Lock()
	sessions := append([]*fakeSession(nil), listener.sessions...)
	listener.mu.Unlock()
	for _, session := range sessions {
		session.closeSession()
	}
	return nil
}

func (listener *fakeListener) sessionsOf(key string) []*fakeSession {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	var sessions []*fakeSession
	for _, session := range listener.sessions {
		if session.key == key {
			sessions = append(sessions, session)
		}
	}
	return sessions
}

func (listener *fakeListener) closedKeys() []string {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return append([]string(nil), listener.closed...)
}

// open connects a phone whose handshake proved key. registered mirrors what
// the transport decided from its registry at admission.
func (listener *fakeListener) open(key, name, remote string, registered bool) *fakeSession {
	address, _ := net.ResolveUDPAddr("udp", remote)
	session := &fakeSession{
		key: key, transport: name, remote: address, registered: registered,
		streams: make(chan transport.Stream, 8), done: make(chan struct{}),
	}
	listener.mu.Lock()
	listener.sessions = append(listener.sessions, session)
	listener.mu.Unlock()
	listener.queue <- session
	return session
}

type fakeSession struct {
	key       string
	transport string
	remote    net.Addr
	streams   chan transport.Stream
	done      chan struct{}

	mu         sync.Mutex
	registered bool
	pipes      []net.Conn
}

var _ transport.Session = (*fakeSession)(nil)

func (session *fakeSession) PeerKey() string   { return session.key }
func (session *fakeSession) Transport() string { return session.transport }
func (session *fakeSession) LocalAddr() net.Addr {
	return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 4740}
}
func (session *fakeSession) RemoteAddr() net.Addr { return session.remote }
func (session *fakeSession) Done() <-chan struct{} {
	return session.done
}

func (session *fakeSession) Registered() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.registered
}

func (session *fakeSession) OpenStream(context.Context) (transport.Stream, error) {
	return nil, transport.ErrStreamRefused
}

func (session *fakeSession) AcceptStream(ctx context.Context) (transport.Stream, error) {
	select {
	case stream := <-session.streams:
		return stream, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-session.done:
		return nil, transport.ErrClosed
	}
}

func (session *fakeSession) Close() error {
	session.closeSession()
	return nil
}

func (session *fakeSession) closedLocked() bool {
	select {
	case <-session.done:
		return true
	default:
		return false
	}
}

func (session *fakeSession) closed() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.closedLocked()
}

func (session *fakeSession) closeSession() bool {
	session.mu.Lock()
	if session.closedLocked() {
		session.mu.Unlock()
		return false
	}
	close(session.done)
	pipes := session.pipes
	session.pipes = nil
	session.mu.Unlock()
	for _, pipe := range pipes {
		_ = pipe.Close()
	}
	return true
}

// dial opens a stream: the edge receives one end, the phone keeps the other.
func (session *fakeSession) dial() (net.Conn, error) {
	server, client := net.Pipe()
	session.mu.Lock()
	if session.closedLocked() {
		session.mu.Unlock()
		return nil, transport.ErrClosed
	}
	session.pipes = append(session.pipes, server, client)
	session.mu.Unlock()
	session.streams <- &fakeStream{Conn: server, session: session}
	return client, nil
}

type fakeStream struct {
	net.Conn
	session *fakeSession
}

func (stream *fakeStream) Session() transport.Session { return stream.session }
func (stream *fakeStream) RemoteAddr() net.Addr       { return stream.session.remote }
