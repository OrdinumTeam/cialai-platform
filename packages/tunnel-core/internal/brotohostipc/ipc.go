// SPDX-License-Identifier: Apache-2.0
// Package brotohostipc exposes only AI-safe host operations over owner-only IPC.
package brotohostipc

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const MaxMessage = 4 << 20

type Handler func(context.Context, string, json.RawMessage) (any, error)
type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type response struct {
	ID     uint64          `json:"id"`
	Event  string          `json:"event,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *failure        `json:"error,omitempty"`
}
type failure struct {
	Message string `json:"message"`
}

func DefaultPath() (string, error) {
	if path := os.Getenv("CIALAI_BROTO_HOST_SOCKET"); path != "" {
		return path, nil
	}
	state := os.Getenv("CIALAI_BROTO_HOST_STATE_DIR")
	if state == "" {
		var base string
		if runtime.GOOS == "linux" {
			base = os.Getenv("XDG_DATA_HOME")
			if base == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return "", err
				}
				base = filepath.Join(home, ".local", "share")
			}
		} else if runtime.GOOS == "windows" {
			base = os.Getenv("LOCALAPPDATA")
		} else {
			var err error
			base, err = os.UserConfigDir()
			if err != nil {
				return "", err
			}
		}
		state = filepath.Join(base, "br.com.ordinum.cialai", "tunnel")
	}
	return PathForStateDir(state)
}

// PathForStateDir selects exactly one host, never another running instance.
func PathForStateDir(state string) (string, error) {
	if p := os.Getenv("CIALAI_BROTO_HOST_SOCKET"); p != "" {
		return p, nil
	}
	if !filepath.IsAbs(state) {
		return "", fmt.Errorf("Broto IPC state directory must be absolute: %q", state)
	}
	state = filepath.Clean(state)
	if canonical, err := filepath.EvalSymlinks(state); err == nil {
		state = canonical
	}
	if runtime.GOOS == "windows" {
		state = strings.ToLower(state)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(state))
	path := platformPath(filepath.Join(home, ".cialai-ipc", fmt.Sprintf("%x.sock", sum[:16])))
	if runtime.GOOS != "windows" && len([]byte(path)) >= 104 {
		return "", fmt.Errorf("Broto IPC %q: path exceeds 103 bytes; set CIALAI_BROTO_HOST_SOCKET inside a short private directory", path)
	}
	return path, nil
}
func safeParams(method string, raw json.RawMessage) (json.RawMessage, error) {
	if method != "broto.list" && method != "broto.sessions" && method != "broto.call" {
		return nil, errors.New("method not allowed")
	}
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var p map[string]json.RawMessage
	if e := json.Unmarshal(raw, &p); e != nil || p == nil {
		return nil, errors.New("object params required")
	}
	if method == "broto.call" {
		var cmd string
		if json.Unmarshal(p["cmd"], &cmd) != nil {
			return nil, errors.New("command required")
		}
		switch cmd {
		case "exec", "pty.open", "pty.list", "pty.read", "pty.write", "pty.kill", "exec.cancel", "files.list", "files.stat", "files.get", "files.put", "files.cancel":
		default:
			return nil, errors.New("command not allowed")
		}
		for key := range p {
			if key != "deviceId" && key != "cmd" && key != "args" && key != "actor" {
				return nil, errors.New("unexpected call parameter")
			}
		}
		p["actor"] = json.RawMessage(`"ai"`)
	}
	p["actor"] = json.RawMessage(`"ai"`)
	return json.Marshal(p)
}
func Serve(ctx context.Context, path string, handler Handler) error {
	listener, e := listen(path)
	if e != nil {
		return e
	}
	return serveListener(ctx, listener, handler)
}

// Start binds synchronously so startup failures reach diagnostics.
func Start(ctx context.Context, path string, handler Handler) (<-chan error, error) {
	listener, err := listen(path)
	if err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- serveListener(ctx, listener, handler); close(done) }()
	return done, nil
}
func serveListener(ctx context.Context, listener net.Listener, handler Handler) error {
	defer listener.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			listener.Close()
		case <-done:
		}
	}()
	slots := make(chan struct{}, 32)
	for {
		conn, e := listener.Accept()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		select {
		case slots <- struct{}{}:
			go func() { defer func() { <-slots }(); serveConn(ctx, conn, handler) }()
		default:
			conn.Close()
		}
	}
}
func serveConn(ctx context.Context, conn net.Conn, handler Handler) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(15 * time.Second))
	ctx, cancel := context.WithTimeout(ctx, 24*time.Hour)
	defer cancel()
	go func(watch context.Context) { <-watch.Done(); _ = conn.Close() }(ctx)
	var req request
	if e := json.NewDecoder(io.LimitReader(conn, MaxMessage)).Decode(&req); e != nil {
		return
	}
	conn.SetDeadline(time.Now().Add(24 * time.Hour))
	go func() { _, _ = io.Copy(io.Discard, conn); cancel() }()
	var writeMu sync.Mutex
	encoder := json.NewEncoder(conn)
	ctx = context.WithValue(ctx, emitterKey{}, func(event string, data json.RawMessage) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := encoder.Encode(response{ID: req.ID, Event: event, Data: data}); err != nil {
			cancel()
		}
	})
	ctx = brotorpc.WithEventSink(ctx, func(event string, data json.RawMessage) { Emit(ctx, event, data) })
	resp := response{ID: req.ID}
	params, e := safeParams(req.Method, req.Params)
	if e == nil {
		var result any
		result, e = handler(ctx, req.Method, params)
		if e == nil {
			resp.Result, e = json.Marshal(result)
			if len(resp.Result) > MaxMessage-1024 {
				e = errors.New("response too large")
				resp.Result = nil
			}
		}
	}
	if e != nil {
		message := e.Error()
		if len(message) > 16384 {
			message = message[:16384]
		}
		resp.Error = &failure{Message: message}
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = encoder.Encode(resp)
}
func Call(ctx context.Context, path, method string, params json.RawMessage) (json.RawMessage, error) {
	return CallStream(ctx, path, method, params, nil)
}

type emitterKey struct{}

func Emit(ctx context.Context, event string, data json.RawMessage) {
	if f, ok := ctx.Value(emitterKey{}).(func(string, json.RawMessage)); ok {
		f(event, data)
	}
}
func CallStream(ctx context.Context, path, method string, params json.RawMessage, event func(string, json.RawMessage)) (json.RawMessage, error) {
	params, e := safeParams(method, params)
	if e != nil {
		return nil, e
	}
	conn, e := dial(ctx, path)
	if e != nil {
		return nil, e
	}
	defer conn.Close()
	deadline := time.Now().Add(24 * time.Hour)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	conn.SetDeadline(deadline)
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	if e = json.NewEncoder(conn).Encode(request{ID: 1, Method: method, Params: params}); e != nil {
		return nil, e
	}
	var resp response
	reader := bufio.NewReader(conn)
	for {
		var frame []byte
		for {
			part, more, err := reader.ReadLine()
			if err != nil {
				return nil, err
			}
			if len(frame)+len(part) > MaxMessage {
				return nil, errors.New("response too large")
			}
			frame = append(frame, part...)
			if !more {
				break
			}
		}
		resp = response{}
		if e = json.Unmarshal(frame, &resp); e != nil {
			return nil, e
		}
		if resp.ID != 1 {
			return nil, fmt.Errorf("unexpected IPC response id")
		}
		if resp.Event == "" {
			break
		}
		if event != nil {
			event(resp.Event, resp.Data)
		}
	}
	if resp.ID != 1 {
		return nil, fmt.Errorf("unexpected IPC response id")
	}
	if resp.Error != nil {
		return nil, errors.New(resp.Error.Message)
	}
	return resp.Result, nil
}
