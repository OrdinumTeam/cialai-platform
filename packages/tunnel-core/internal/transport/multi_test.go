// SPDX-License-Identifier: Apache-2.0
package transport

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

const multiTimeout = 5 * time.Second

type fakeSession struct {
	key       string
	transport string
	closeOnce sync.Once
	done      chan struct{}
}

func newFakeSession(key, name string) *fakeSession {
	return &fakeSession{key: key, transport: name, done: make(chan struct{})}
}

func (session *fakeSession) PeerKey() string   { return session.key }
func (session *fakeSession) Transport() string { return session.transport }
func (session *fakeSession) Registered() bool  { return true }
func (session *fakeSession) OpenStream(context.Context) (Stream, error) {
	return nil, ErrStreamRefused
}
func (session *fakeSession) AcceptStream(ctx context.Context) (Stream, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (session *fakeSession) LocalAddr() net.Addr   { return nil }
func (session *fakeSession) RemoteAddr() net.Addr  { return nil }
func (session *fakeSession) Done() <-chan struct{} { return session.done }
func (session *fakeSession) Close() error {
	session.closeOnce.Do(func() { close(session.done) })
	return nil
}

func (session *fakeSession) closed() bool {
	select {
	case <-session.done:
		return true
	default:
		return false
	}
}

type fakeListener struct {
	name      string
	queue     chan Session
	closing   chan struct{}
	closeOnce sync.Once
	mu        sync.Mutex
	promoted  []string
	closedKey []string
}

func newFakeListener(name string) *fakeListener {
	return &fakeListener{name: name, queue: make(chan Session, 4), closing: make(chan struct{})}
}

func (listener *fakeListener) Accept(ctx context.Context) (Session, error) {
	select {
	case session := <-listener.queue:
		return session, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-listener.closing:
		return nil, ErrClosed
	}
}

func (listener *fakeListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: len(listener.name)}
}

func (listener *fakeListener) Promote(key string) int {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	listener.promoted = append(listener.promoted, key)
	return 1
}

func (listener *fakeListener) CloseKey(key string) int {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	listener.closedKey = append(listener.closedKey, key)
	return 2
}

func (listener *fakeListener) Close() error {
	listener.closeOnce.Do(func() { close(listener.closing) })
	return nil
}

func acceptWithin(t *testing.T, listener Listener) Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), multiTimeout)
	defer cancel()
	session, err := listener.Accept(ctx)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	return session
}

func TestMultiListenerAcceptsFromEveryListenerAndFansOutKeys(t *testing.T) {
	direct, tor := newFakeListener(NameDirect), newFakeListener(NameTor)
	multi := NewMultiListener(direct, tor)
	defer multi.Close()

	tor.queue <- newFakeSession("key-a", NameTor)
	if session := acceptWithin(t, multi); session.Transport() != NameTor {
		t.Fatalf("got %s session, want tor", session.Transport())
	}
	direct.queue <- newFakeSession("key-b", NameDirect)
	if session := acceptWithin(t, multi); session.Transport() != NameDirect {
		t.Fatalf("got %s session, want direct", session.Transport())
	}

	if promoted := multi.Promote("key-a"); promoted != 2 {
		t.Fatalf("promoted %d sessions, want one per listener", promoted)
	}
	if closed := multi.CloseKey("key-a"); closed != 4 {
		t.Fatalf("closed %d sessions, want the sum of both listeners", closed)
	}
	for _, listener := range []*fakeListener{direct, tor} {
		listener.mu.Lock()
		if len(listener.promoted) != 1 || len(listener.closedKey) != 1 || listener.closedKey[0] != "key-a" {
			t.Fatalf("%s listener missed the key fan-out: %v %v", listener.name, listener.promoted, listener.closedKey)
		}
		listener.mu.Unlock()
	}
	if addresses := multi.Addrs(); len(addresses) != 2 || multi.Addr().String() != addresses[0].String() {
		t.Fatalf("unexpected addresses: %v", addresses)
	}
}

func TestMultiListenerSurvivesOneListenerAndClosesEverything(t *testing.T) {
	direct, tor := newFakeListener(NameDirect), newFakeListener(NameTor)
	multi := NewMultiListener(direct, tor)

	_ = tor.Close()
	direct.queue <- newFakeSession("key-a", NameDirect)
	if session := acceptWithin(t, multi); session.PeerKey() != "key-a" {
		t.Fatal("the remaining listener stopped accepting")
	}

	// A session taken from a listener while nobody waits is closed by Close.
	pending := newFakeSession("key-late", NameDirect)
	direct.queue <- pending
	time.Sleep(20 * time.Millisecond)
	if err := multi.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-direct.closing:
	default:
		t.Fatal("Close did not close the listeners")
	}
	if !pending.closed() && len(direct.queue) != 1 {
		t.Fatal("a session accepted during Close leaked")
	}
	ctx, cancel := context.WithTimeout(context.Background(), multiTimeout)
	defer cancel()
	if _, err := multi.Accept(ctx); !errors.Is(err, ErrClosed) {
		t.Fatalf("Accept after Close: %v", err)
	}
}

func TestMultiListenerReportsClosedWhenAllListenersStop(t *testing.T) {
	direct := newFakeListener(NameDirect)
	multi := NewMultiListener(direct)
	defer multi.Close()
	_ = direct.Close()
	ctx, cancel := context.WithTimeout(context.Background(), multiTimeout)
	defer cancel()
	if _, err := multi.Accept(ctx); !errors.Is(err, ErrClosed) {
		t.Fatalf("Accept with every listener stopped: %v", err)
	}
}
