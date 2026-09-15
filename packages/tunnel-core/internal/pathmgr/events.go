// SPDX-License-Identifier: Apache-2.0
package pathmgr

import "sync"

// dispatcher runs event callbacks in order on one goroutine, so emitting under
// the manager lock never waits for a callback.
type dispatcher struct {
	mu     sync.Mutex
	queue  []func()
	closed bool
	wake   chan struct{}
	done   chan struct{}
}

func newDispatcher() *dispatcher {
	events := &dispatcher{wake: make(chan struct{}, 1), done: make(chan struct{})}
	go events.loop()
	return events
}

func (events *dispatcher) post(callback func()) {
	events.mu.Lock()
	if events.closed {
		events.mu.Unlock()
		return
	}
	events.queue = append(events.queue, callback)
	events.mu.Unlock()
	events.signal()
}

func (events *dispatcher) signal() {
	select {
	case events.wake <- struct{}{}:
	default:
	}
}

func (events *dispatcher) loop() {
	defer close(events.done)
	for {
		events.mu.Lock()
		batch, closed := events.queue, events.closed
		events.queue = nil
		events.mu.Unlock()
		for _, callback := range batch {
			callback()
		}
		if len(batch) > 0 {
			continue
		}
		if closed {
			return
		}
		<-events.wake
	}
}

// close delivers the queued events and waits for the loop to end.
func (events *dispatcher) close() {
	events.mu.Lock()
	events.closed = true
	events.mu.Unlock()
	events.signal()
	<-events.done
}
