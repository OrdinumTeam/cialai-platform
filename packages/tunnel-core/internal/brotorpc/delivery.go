package brotorpc

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

var errOutputBackpressure = errors.New("output_backpressure: output consumer could not keep up; execution cancelled")

const outputQueueBytes = 4 << 20
const outputQueueEvents = 32

type deliveryItem struct {
	name string
	data json.RawMessage
	ack  chan struct{}
}

// One consumer per queue. The wire reader only enqueues: no user callback runs
// on the reader, and neither an IPC writer nor the UI can hold up other calls.
type eventDelivery struct {
	mu      sync.Mutex
	queue   []deliveryItem
	bytes   int
	sealed  bool
	failed  bool
	wake    chan struct{}
	failure chan struct{}
	done    chan struct{}
	consume func(string, json.RawMessage)
}

func newEventDelivery(consume func(string, json.RawMessage)) *eventDelivery {
	d := &eventDelivery{wake: make(chan struct{}, 1), failure: make(chan struct{}), done: make(chan struct{}), consume: consume}
	go d.run()
	return d
}
func (d *eventDelivery) push(item deliveryItem) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.sealed || d.failed {
		return
	}
	// A flush marker consumes no output quota and must fit behind a full queue.
	if item.ack == nil && (len(d.queue) >= outputQueueEvents || d.bytes+len(item.data) > outputQueueBytes) {
		d.failed = true
		close(d.failure)
		return
	}
	d.queue = append(d.queue, item)
	d.bytes += len(item.data)
	select {
	case d.wake <- struct{}{}:
	default:
	}
}
func (d *eventDelivery) flush(ctx context.Context) error {
	ack := make(chan struct{})
	d.push(deliveryItem{ack: ack})
	select {
	case <-d.failure:
		return errOutputBackpressure
	case <-ctx.Done():
		return ctx.Err()
	case <-ack:
		select {
		case <-d.failure:
			return errOutputBackpressure
		default:
			return nil
		}
	}
}
func (d *eventDelivery) finish(name string, data json.RawMessage, aborted bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.sealed {
		return
	}
	if aborted {
		for _, item := range d.queue {
			d.bytes -= len(item.data)
		}
		d.queue = nil
	}
	if name != "" {
		d.queue = append(d.queue, deliveryItem{name: name, data: data})
		d.bytes += len(data)
	}
	d.sealed = true
	select {
	case d.wake <- struct{}{}:
	default:
	}
}
func (d *eventDelivery) run() {
	defer close(d.done)
	for {
		d.mu.Lock()
		if len(d.queue) == 0 {
			sealed := d.sealed
			d.mu.Unlock()
			if sealed {
				return
			}
			<-d.wake
			continue
		}
		item := d.queue[0]
		d.queue[0] = deliveryItem{}
		d.queue = d.queue[1:]
		d.mu.Unlock()
		if item.ack != nil {
			close(item.ack)
		} else {
			d.consume(item.name, item.data)
		}
		d.mu.Lock()
		d.bytes -= len(item.data)
		d.mu.Unlock()
	}
}
