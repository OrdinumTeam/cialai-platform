package brotorpc

import (
	"context"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"
)

func automationHub(t *testing.T) (*Hub, net.Conn) {
	t.Helper()
	h := NewHub()
	host, client := net.Pipe()
	t.Cleanup(func() { h.Close(); client.Close() })
	go h.Attach("test", host)
	m, err := Read(client)
	if err != nil {
		t.Fatal(err)
	}
	if err = Write(client, Message{ID: m.ID, OK: true, Result: json.RawMessage(`{"version":1,"shell":"/bin/sh"}`)}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if on, _ := h.State("test"); on {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("attach timeout")
		}
		time.Sleep(time.Millisecond)
	}
	return h, client
}
func TestGrantResolvesApprovalAndReadLevelStillWins(t *testing.T) {
	h, c := automationHub(t)
	var levelMu sync.Mutex
	level := "confirm"
	h.Level = func(string) string { levelMu.Lock(); defer levelMu.Unlock(); return level }
	events := make(chan string, 16)
	h.Event = func(name string, _ any) { events <- name }
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := h.Call(ctx, "test", "exec", "ai", json.RawMessage(`{"command":"tool"}`))
		done <- err
	}()
	for {
		select {
		case name := <-events:
			if name == "broto.requests.changed" {
				goto pending
			}
		case <-ctx.Done():
			t.Fatal("no request event")
		}
	}
pending:
	if len(h.Pending()) != 1 {
		t.Fatal("no pending")
	}
	if err := h.Grant("test"); err != nil {
		t.Fatal(err)
	}
	m, err := Read(c)
	if err != nil {
		t.Fatal(err)
	}
	Write(c, Message{ID: m.ID, OK: true, Result: json.RawMessage(`{"exit_code":0}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(h.Pending()) != 0 || h.ApprovalUntil("test") == "" {
		t.Fatal("approval not resolved")
	}
	levelMu.Lock()
	level = "read"
	levelMu.Unlock()
	if _, err := h.Call(ctx, "test", "files.get", "ai", json.RawMessage(`{"path":"a"}`)); err == nil {
		t.Fatal("grant bypassed read only")
	}
	h.EndGrant("test")
	if h.ApprovalUntil("test") != "" {
		t.Fatal("grant remains")
	}
}
func TestContextCancellationCancelsPeerAndFinishesCard(t *testing.T) {
	h, c := automationHub(t)
	h.Level = func(string) string { return "free" }
	events := make(chan string, 8)
	h.Event = func(name string, _ any) { events <- name }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := h.Call(ctx, "test", "exec", "ai", json.RawMessage(`{"command":"long","stream":true}`))
		done <- err
	}()
	m, err := Read(c)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	stop, err := Read(c)
	if err != nil {
		t.Fatal(err)
	}
	var args struct {
		ID uint64 `json:"call_id"`
	}
	json.Unmarshal(stop.Args, &args)
	if stop.Cmd != "exec.cancel" || args.ID != m.ID {
		t.Fatal("missing correlated cancel")
	}
	if err := <-done; err != context.Canceled {
		t.Fatal(err)
	}
	for {
		select {
		case name := <-events:
			if name == "broto.exec.finished" {
				return
			}
		case <-time.After(time.Second):
			t.Fatal("missing finished")
		}
	}
}

func waitAutomationPending(t *testing.T, h *Hub) Approval {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if pending := h.Pending(); len(pending) > 0 {
			return pending[0]
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("approval not queued")
	return Approval{}
}
func TestTransferApprovalReusedOnlyUntilCancel(t *testing.T) {
	h, c := automationHub(t)
	h.Level = func(string) string { return "confirm" }
	go func() {
		for {
			m, err := Read(c)
			if err != nil {
				return
			}
			if Write(c, Message{ID: m.ID, OK: true, Result: json.RawMessage(`{"complete":false}`)}) != nil {
				return
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	args := json.RawMessage(`{"path":"file","transfer_id":"unique","size":12,"data":"c2VjcmV0","overwrite":false}`)
	done := make(chan error, 1)
	go func() { _, err := h.Call(ctx, "test", "files.put", "ai", args); done <- err }()
	a := waitAutomationPending(t, h)
	var preview map[string]any
	if json.Unmarshal([]byte(a.Summary), &preview) != nil {
		t.Fatal("bad preview")
	}
	if preview["data"] != nil || preview["direction"] != "to_broto" || preview["size"] != float64(12) {
		t.Fatal("invalid transfer preview")
	}
	if err := h.Decide(a.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := h.Call(ctx, "test", "files.put", "ai", args); err != nil {
		t.Fatal("second chunk requested approval", err)
	}
	if _, err := h.Call(ctx, "test", "files.cancel", "ai", json.RawMessage(`{"path":"file","transfer_id":"unique"}`)); err != nil {
		t.Fatal(err)
	}
	go func() { _, err := h.Call(ctx, "test", "files.put", "ai", args); done <- err }()
	a = waitAutomationPending(t, h)
	h.Decide(a.ID, false)
	if err := <-done; err == nil {
		t.Fatal("cancelled transfer authorization reused")
	}
}
