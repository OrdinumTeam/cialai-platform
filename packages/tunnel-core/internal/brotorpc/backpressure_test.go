package brotorpc

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPendingApprovalsAreOldestFirst(t *testing.T) {
	h := NewHub()
	for i := uint64(1); i <= 50; i++ {
		h.pending[i] = &Approval{ID: i}
	}
	for range 20 {
		for i, a := range h.Pending() {
			if a.ID != uint64(i+1) {
				t.Fatalf("pending order unstable: index %d id %d", i, a.ID)
			}
		}
	}
}
func TestSlowExecSubscriberDoesNotBlockOtherCalls(t *testing.T) {
	for _, app := range []bool{false, true} {
		name := "ipc"
		if app {
			name = "app"
		}
		t.Run(name, func(t *testing.T) { testSlowSubscriber(t, app) })
	}
}
func testSlowSubscriber(t *testing.T, app bool) {
	h, c := automationHub(t)
	h.Level = func(string) string { return "free" }
	release := make(chan struct{})
	defer close(release)
	entered := make(chan struct{}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	consume := func(name string, _ json.RawMessage) {
		if name == "broto.exec.output" {
			select {
			case entered <- struct{}{}:
			default:
			}
			<-release
		}
	}
	if app {
		h.Event = func(name string, data any) { raw, _ := json.Marshal(data); consume(name, raw) }
	} else {
		ctx = WithEventSink(ctx, consume)
	}
	done := make(chan error, 1)
	go func() {
		_, err := h.Call(ctx, "test", "exec", "ai", json.RawMessage(`{"command":"busy","stream":true}`))
		done <- err
	}()
	m, err := Read(c)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"callId": m.ID, "channel": "stdout", "data": "eA=="})
	if err = Write(c, Message{Event: "exec.output", Data: data}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("subscriber not reached")
	}
	listDone := make(chan error, 1)
	go func() { _, err := h.Call(ctx, "test", "pty.list", "human", json.RawMessage(`{}`)); listDone <- err }()
	m, err = Read(c)
	if err != nil {
		t.Fatal(err)
	}
	written := make(chan error, 1)
	go func() { written <- Write(c, Message{ID: m.ID, OK: true, Result: json.RawMessage(`[]`)}) }()
	select {
	case err := <-listDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(150 * time.Millisecond):
		t.Fatal("slow output subscriber blocked independent pty.list response")
	}
}
func TestExecOutputOverflowCancelsOnlyItsCall(t *testing.T) {
	h, c := automationHub(t)
	h.Level = func(string) string { return "free" }
	release := make(chan struct{})
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ctx = WithEventSink(ctx, func(name string, _ json.RawMessage) {
		if name == "broto.exec.output" {
			<-release
		}
	})
	done := make(chan error, 1)
	go func() {
		_, err := h.Call(ctx, "test", "exec", "ai", json.RawMessage(`{"command":"busy","stream":true}`))
		done <- err
	}()
	m, err := Read(c)
	if err != nil {
		t.Fatal(err)
	}
	original := m.ID
	go func() {
		data, _ := json.Marshal(map[string]any{"callId": original, "channel": "stdout", "data": "eA=="})
		for range 100 {
			if Write(c, Message{Event: "exec.output", Data: data}) != nil {
				return
			}
		}
	}()
	stop := make(chan Message, 1)
	go func() { m, _ := Read(c); stop <- m }()
	select {
	case m := <-stop:
		if m.Cmd != "exec.cancel" {
			t.Fatalf("expected cancel, got %s", m.Cmd)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("overflow did not cancel execution")
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "output_backpressure") {
			t.Fatalf("missing explicit output error: %v", err)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("overflow left call blocked")
	}
}

func TestFullOutputQueueDrainsBeforeSuccessfulFinalResponse(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	delivered := 0
	d := newEventDelivery(func(_ string, _ json.RawMessage) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		delivered++
	})
	d.push(deliveryItem{name: "broto.exec.output", data: json.RawMessage(`{}`)})
	<-entered
	for range outputQueueEvents {
		d.push(deliveryItem{name: "broto.exec.output", data: json.RawMessage(`{}`)})
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- d.flush(ctx) }()
	for {
		d.mu.Lock()
		queued := len(d.queue)
		d.mu.Unlock()
		if queued > outputQueueEvents {
			break
		}
		select {
		case <-d.failure:
			t.Fatal("flush barrier overflowed valid full queue")
		case <-ctx.Done():
			t.Fatal("flush did not enqueue barrier")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	once.Do(func() { close(release) })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	d.finish("", nil, false)
	<-d.done
	if delivered != outputQueueEvents+1 {
		t.Fatalf("tail lost: %d", delivered)
	}
}
