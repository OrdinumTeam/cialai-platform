// SPDX-License-Identifier: Apache-2.0
package transport

import (
	"context"
	"errors"
	"net"
	"sync"
)

// MultiListener joins several listeners, such as the direct QUIC listener and
// the Tor onion listener, into one accept point. Promote and CloseKey reach
// every listener, so a revocation closes the sessions of a key on all
// transports at once.
type MultiListener struct {
	listeners []Listener
	sessions  chan Session
	ctx       context.Context
	cancel    context.CancelFunc
	closing   chan struct{}
	closeOnce sync.Once
	closeErr  error
	pumps     sync.WaitGroup
	drained   chan struct{}
}

var _ Listener = (*MultiListener)(nil)

// NewMultiListener starts accepting from every listener. The multi listener
// owns them: Close closes each one. A listener that stops accepting leaves the
// others running; Accept fails with ErrClosed once all of them stopped.
func NewMultiListener(listeners ...Listener) *MultiListener {
	ctx, cancel := context.WithCancel(context.Background())
	multi := &MultiListener{
		listeners: append([]Listener(nil), listeners...),
		sessions:  make(chan Session),
		ctx:       ctx,
		cancel:    cancel,
		closing:   make(chan struct{}),
		drained:   make(chan struct{}),
	}
	for _, listener := range multi.listeners {
		multi.pumps.Add(1)
		go multi.pump(listener)
	}
	go func() {
		multi.pumps.Wait()
		close(multi.drained)
	}()
	return multi
}

// pump hands the sessions of one listener to Accept. The channel is unbuffered,
// so a session is only taken from its listener when a caller waits for it.
func (multi *MultiListener) pump(listener Listener) {
	defer multi.pumps.Done()
	for {
		session, err := listener.Accept(multi.ctx)
		if err != nil {
			return
		}
		select {
		case multi.sessions <- session:
		case <-multi.closing:
			_ = session.Close()
			return
		}
	}
}

// Accept returns the next session from any listener.
func (multi *MultiListener) Accept(ctx context.Context) (Session, error) {
	select {
	case session := <-multi.sessions:
		return session, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-multi.closing:
		return nil, ErrClosed
	case <-multi.drained:
		return nil, ErrClosed
	}
}

// Addr is the address of the first listener; Addrs lists all of them.
func (multi *MultiListener) Addr() net.Addr {
	if len(multi.listeners) == 0 {
		return nil
	}
	return multi.listeners[0].Addr()
}

// Addrs returns the address of every listener, in construction order.
func (multi *MultiListener) Addrs() []net.Addr {
	addresses := make([]net.Addr, 0, len(multi.listeners))
	for _, listener := range multi.listeners {
		addresses = append(addresses, listener.Addr())
	}
	return addresses
}

// Promote lifts the restricted entry from key on every listener.
func (multi *MultiListener) Promote(key string) int {
	promoted := 0
	for _, listener := range multi.listeners {
		promoted += listener.Promote(key)
	}
	return promoted
}

// CloseKey closes the sessions of key on every listener.
func (multi *MultiListener) CloseKey(key string) int {
	closed := 0
	for _, listener := range multi.listeners {
		closed += listener.CloseKey(key)
	}
	return closed
}

// Close stops accepting and closes every listener.
func (multi *MultiListener) Close() error {
	multi.closeOnce.Do(func() {
		close(multi.closing)
		multi.cancel()
		var errs []error
		for _, listener := range multi.listeners {
			if err := listener.Close(); err != nil && !errors.Is(err, ErrClosed) {
				errs = append(errs, err)
			}
		}
		multi.pumps.Wait()
		multi.closeErr = errors.Join(errs...)
	})
	return multi.closeErr
}
