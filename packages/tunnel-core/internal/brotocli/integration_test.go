package brotocli

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoexec"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"net"
	"runtime"
	"sync"
	"testing"
	"time"
)

// Exercises the CLI contract through the real hub wire and command executor.
func TestCLIThroughHubStreamsAndWaitsForApproval(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	hub := brotorpc.NewHub()
	hub.Level = func(string) string { return "confirm" }
	defer hub.Close()
	host, peer := net.Pipe()
	defer peer.Close()
	var mu sync.Mutex
	send := func(m brotorpc.Message) { mu.Lock(); defer mu.Unlock(); _ = brotorpc.Write(peer, m) }
	ex := brotoexec.New(brotoexec.Config{AllowExec: true, OnExecOutput: func(id uint64, ch string, b []byte) {
		send(brotorpc.Message{Event: "exec.output", Data: encode(map[string]any{"callId": id, "channel": ch, "data": b})})
	}})
	defer ex.Close()
	go hub.Attach("device", host)
	go func() {
		for {
			m, e := brotorpc.Read(peer)
			if e != nil {
				return
			}
			go func(m brotorpc.Message) {
				v, e := ex.HandleCall(ctx, m.ID, m.Cmd, m.Args)
				reply := brotorpc.Message{ID: m.ID, OK: e == nil, Result: encode(v)}
				if e != nil {
					reply.Error = e.Error()
				}
				send(reply)
			}(m)
		}
	}()
	for {
		on, _ := hub.State("device")
		if on {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	var out, stderr bytes.Buffer
	call := func(ctx context.Context, method string, p json.RawMessage) (json.RawMessage, error) {
		if method == "broto.list" {
			return encode([]Device{{ID: "device", Name: "test", State: "connected", Level: "confirm", Platform: runtime.GOOS, Shell: "/bin/sh"}}), nil
		}
		var v struct {
			Cmd  string          `json:"cmd"`
			Args json.RawMessage `json:"args"`
		}
		json.Unmarshal(p, &v)
		return hub.Call(ctx, "device", v.Cmd, "ai", v.Args)
	}
	cli := CLI{Call: call, Out: &out, Err: &stderr, Stream: func(ctx context.Context, m string, p json.RawMessage, f func(string, json.RawMessage)) (json.RawMessage, error) {
		return call(brotorpc.WithEventSink(ctx, f), m, p)
	}}
	approved := make(chan bool, 1)
	go func() {
		for {
			pending := hub.Pending()
			if len(pending) > 0 {
				approved <- hub.Decide(pending[0].ID, true) == nil
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	code := cli.Run(ctx, []string{"rodar", "1", "echo cialai-stream-proof"})
	if code != 0 || !bytes.Contains(out.Bytes(), []byte("cialai-stream-proof")) {
		t.Fatalf("code %d out %s err %s", code, out.String(), stderr.String())
	}
	select {
	case ok := <-approved:
		if !ok {
			t.Fatal("approval failed")
		}
	default:
		t.Fatal("approval bypassed")
	}
	if len(hub.Pending()) != 0 {
		t.Fatal("approval was not cleared")
	}
}
