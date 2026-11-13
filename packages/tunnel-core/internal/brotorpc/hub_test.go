// SPDX-License-Identifier: Apache-2.0
package brotorpc

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func TestWireBoundsAndBinary(t *testing.T) {
	var b bytes.Buffer
	if err := WriteOutput(&b, 19, []byte{0, 255, 1}); err != nil {
		t.Fatal(err)
	}
	m, err := Read(&b)
	if err != nil || m.Channel != 19 || !bytes.Equal(m.Output, []byte{0, 255, 1}) {
		t.Fatal("binary mismatch", err)
	}
	if _, err = Read(bytes.NewReader([]byte{255, 255, 255, 255})); err == nil {
		t.Fatal("unbounded frame")
	}
	// Two 256 KiB outputs filled with control bytes expand sixfold in JSON.
	raw, _ := json.Marshal(map[string]string{"stdout": string(bytes.Repeat([]byte{0}, 256<<10)), "stderr": string(bytes.Repeat([]byte{1}, 256<<10))})
	if err = Write(&b, Message{ID: 1, OK: true, Result: raw}); err != nil {
		t.Fatal("bounded exec output rejected", err)
	}
	if _, err = Read(&b); err != nil {
		t.Fatal(err)
	}
}
func TestConfirmationReadOnlyPauseAndDisconnect(t *testing.T) {
	h := NewHub()
	h.Level = func(string) string { return "confirm" }
	host, client := net.Pipe()
	defer client.Close()
	defer h.Close()
	go h.Attach("bro_test", host)
	go func() {
		m, e := Read(client)
		if e == nil {
			Write(client, Message{ID: m.ID, OK: true, Result: json.RawMessage(`{"version":1}`)})
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		on, _ := h.State("bro_test")
		if on {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	result := make(chan error, 1)
	go func() {
		_, err := h.Call(ctx, "bro_test", "exec", "ai", json.RawMessage(`{"command":"tool","args":["check"],"env":{"TOKEN":"private-test-value"}}`))
		result <- err
	}()
	var pending []Approval
	for {
		pending = h.Pending()
		if len(pending) > 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if pending[0].Actor != "ai" {
		t.Fatal("actor lost")
	}
	for _, expected := range []string{"tool", "check", "TOKEN"} {
		if !strings.Contains(pending[0].Summary, expected) {
			t.Fatalf("approval preview missing %s", expected)
		}
	}
	if strings.Contains(pending[0].Summary, "private-test-value") {
		t.Fatal("approval preview exposed environment value")
	}
	if err := h.Decide(pending[0].ID, false); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil {
		t.Fatal("denial bypassed")
	}
	// The person at the host decides by acting; only the AI waits for a yes.
	go func() {
		m, e := Read(client)
		if e == nil {
			Write(client, Message{ID: m.ID, OK: true, Result: json.RawMessage(`{"id":1}`)})
		}
	}()
	if _, err := h.Call(ctx, "bro_test", "pty.open", "human", json.RawMessage(`{"cols":80,"rows":24}`)); err != nil || len(h.Pending()) != 0 {
		t.Fatalf("human terminal waited for approval: %v", err)
	}
	h.Level = func(string) string { return "free" }
	go func() {
		m, e := Read(client)
		if e == nil {
			Write(client, Message{ID: m.ID, OK: true, Result: json.RawMessage(`{"exit_code":0}`)})
		}
	}()
	if _, err := h.Call(ctx, "bro_test", "exec", "human", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if err := Write(client, Message{Event: "paused", Data: json.RawMessage(`{"paused":true}`)}); err != nil {
		t.Fatal(err)
	}
	for {
		_, p := h.State("bro_test")
		if p {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if _, err := h.Call(ctx, "bro_test", "exec", "ai", json.RawMessage(`{}`)); err == nil {
		t.Fatal("pause bypassed")
	}
	h.Level = func(string) string { return "read" }
	if _, err := h.Call(ctx, "bro_test", "pty.open", "ai", json.RawMessage(`{}`)); err == nil {
		t.Fatal("read only bypassed")
	}
}

func TestDisconnectAcknowledgedAfterHostRevocation(t *testing.T) {
	h := NewHub()
	defer h.Close()
	revoked := make(chan struct{})
	h.Disconnect = func(string) { close(revoked) }
	host, client := net.Pipe()
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	done := make(chan struct{})
	go func() { h.Attach("bro_test", host); close(done) }()
	hello, err := Read(client)
	if err != nil {
		t.Fatal(err)
	}
	if err = Write(client, Message{ID: hello.ID, OK: true, Result: json.RawMessage(`{"version":1}`)}); err != nil {
		t.Fatal(err)
	}
	if err = Write(client, Message{Event: "disconnected"}); err != nil {
		t.Fatal(err)
	}
	ack, err := Read(client)
	if err != nil || ack.Event != "disconnected.ack" {
		t.Fatal("missing disconnect acknowledgement", err)
	}
	select {
	case <-revoked:
	default:
		t.Fatal("acknowledged before host revocation")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("connection did not close after acknowledgement")
	}
}
