// SPDX-License-Identifier: Apache-2.0
package brotohostipc

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestIPCForcesActorAndPermissionErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(privateDir(t), "host.sock")
	if runtime.GOOS == "windows" {
		path = platformPath(path)
	}
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, path, func(ctx context.Context, method string, args json.RawMessage) (any, error) {
			if strings.Contains(string(args), `"stream":true`) {
				for i := 0; i < 80; i++ {
					Emit(ctx, "broto.exec.output", json.RawMessage(`{"data":"`+strings.Repeat("a", 65536)+`"}`))
				}
				return map[string]bool{"ok": true}, nil
			}
			if method == "broto.call" {
				var p map[string]any
				json.Unmarshal(args, &p)
				if p["actor"] != "ai" {
					t.Error("actor was not forced")
				}
				return nil, errors.New("read-only Broto")
			}
			if strings.Contains(string(args), `"large":true`) {
				return map[string]string{"stdout": strings.Repeat("\x00", 256<<10), "stderr": strings.Repeat("\x00", 256<<10)}, nil
			}
			return []string{"device"}, nil
		})
	}()
	for i := 0; i < 100; i++ {
		probe, stop := context.WithTimeout(ctx, 100*time.Millisecond)
		_, err := Call(probe, path, "broto.list", json.RawMessage(`{}`))
		stop()
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	raw, e := Call(ctx, path, "broto.list", json.RawMessage(`{}`))
	if e != nil || string(raw) != `["device"]` {
		t.Fatalf("list: %s %v", raw, e)
	}
	_, e = Call(ctx, path, "broto.call", json.RawMessage(`{"deviceId":"device","cmd":"exec","actor":"human","args":{}}`))
	if e == nil || e.Error() != "read-only Broto" {
		t.Fatalf("permission failure not retained: %v", e)
	}
	large, largeErr := Call(ctx, path, "broto.list", json.RawMessage(`{"large":true}`))
	if largeErr != nil || len(large) < 3<<20 {
		t.Fatalf("large escaped exec output: bytes %d err %v", len(large), largeErr)
	}
	_, e = Call(ctx, path, "broto.revoke", json.RawMessage(`{}`))
	if e == nil {
		t.Fatal("admin method accepted")
	}
	_, e = Call(ctx, path, "broto.call", json.RawMessage(`{"cmd":"admin"}`))
	if e == nil {
		t.Fatal("admin command accepted")
	}
	count := 0
	_, e = CallStream(ctx, path, "broto.list", json.RawMessage(`{"stream":true}`), func(event string, raw json.RawMessage) { count++ })
	if e != nil || count != 80 {
		t.Fatalf("stream count %d err %v", count, e)
	}
	cancel()
	if e = <-done; e != nil {
		t.Fatal(e)
	}
}
func TestRejectUnsafeSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions")
	}
	path := filepath.Join(privateDir(t), "socket")
	os.WriteFile(path, []byte("not a socket"), 0600)
	if _, e := Call(context.Background(), path, "broto.list", nil); e == nil {
		t.Fatal("regular file accepted")
	}
}

func TestStreamingAndClientCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := privateDir(t)
	path := platformPath(filepath.Join(dir, "h.sock"))
	var e error
	stopped := make(chan struct{})
	go Serve(ctx, path, func(ctx context.Context, m string, p json.RawMessage) (any, error) {
		if m == "broto.list" {
			return []string{}, nil
		}
		Emit(ctx, "broto.exec.output", json.RawMessage(`{"data":"aGk="}`))
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	})
	for i := 0; i < 100; i++ {
		if _, e = Call(ctx, path, "broto.list", nil); e == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	callCtx, stop := context.WithCancel(ctx)
	count := 0
	_, e = CallStream(callCtx, path, "broto.call", json.RawMessage(`{"cmd":"exec"}`), func(event string, p json.RawMessage) { count++; stop() })
	if e == nil || count != 1 {
		t.Fatalf("events %d err %v", count, e)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("client disconnect did not cancel handler")
	}
}

func TestStalledEventReaderDoesNotHoldCancelledHandler(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	server, client := net.Pipe()
	defer client.Close()
	writing := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		serveConn(ctx, server, func(ctx context.Context, m string, p json.RawMessage) (any, error) {
			close(writing)
			Emit(ctx, "output", json.RawMessage(`{"data":"blocked"}`))
			return nil, ctx.Err()
		})
	}()
	if e := json.NewEncoder(client).Encode(request{ID: 1, Method: "broto.list", Params: json.RawMessage(`{}`)}); e != nil {
		t.Fatal(e)
	}
	<-writing
	cancel()
	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("cancelled IPC handler held by unread event")
	}
}
