package brotoexec

import (
	"bytes"
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
	"time"
)

func call(t *testing.T, e *Executor, verb string, args any) any {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	result, err := e.Handle(context.Background(), verb, raw)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func testConfig() Config {
	return Config{AllowExec: true, AllowPTY: true, MaxDuration: time.Second}
}
func TestExecResultsAndDeadline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix commands")
	}
	e := New(testConfig())
	defer e.Close()
	result := call(t, e, "exec", Args{Command: "/bin/sh", Args: []string{"-c", "printf out; printf err >&2; exit 7"}}).(map[string]any)
	if result["stdout"] != "out" || result["stderr"] != "err" || result["exit_code"] != 7 {
		t.Fatalf("unexpected result %v", result)
	}
	start := time.Now()
	result = call(t, e, "exec", Args{Command: "/bin/sh", Args: []string{"-c", "sleep 20"}, TimeoutMS: 30}).(map[string]any)
	if result["timed_out"] != true || time.Since(start) > 2*time.Second {
		t.Fatalf("deadline not enforced %v", result)
	}
}
func TestCeilingPauseAndAudit(t *testing.T) {
	e := New(Config{})
	defer e.Close()
	raw := json.RawMessage(`{"command":"secret-value"}`)
	if _, err := e.Handle(context.Background(), "exec", raw); err == nil {
		t.Fatal("exec enabled by default")
	}
	e.SetPaused(true)
	if _, err := e.Handle(context.Background(), "hello", nil); err != nil {
		t.Fatal("paused capabilities unavailable")
	}
	if _, err := e.Handle(context.Background(), "exec", raw); err == nil {
		t.Fatal("paused mutation accepted")
	}
	e.SetPaused(false)
	for range 300 {
		_, _ = e.Handle(context.Background(), "secret-command", raw)
	}
	audit := e.Audit()
	if len(audit) != 256 {
		t.Fatal("audit unbounded")
	}
	b, _ := json.Marshal(audit)
	if strings.Contains(string(b), "secret") {
		t.Fatal("audit contains request content")
	}
}
func TestOutputBound(t *testing.T) {
	b := &bounded{limit: 3}
	n, _ := b.Write([]byte("123456"))
	if n != 6 || b.String() != "123" || !b.truncated {
		t.Fatal("bound not applied")
	}
}

func TestPausedReadUsesBoundedChunksAndOffsets(t *testing.T) {
	e := New(Config{})
	e.sessions[1] = &session{data: bytes.Repeat([]byte("x"), 200<<10), offset: 123, done: true}
	e.paused = true
	result := call(t, e, "pty.read", Args{ID: 1}).(map[string]any)
	if len(result["data"].([]byte)) != 64<<10 || result["offset"] != uint64(123) || result["next_offset"] != uint64(123+64<<10) {
		t.Fatalf("bad read bounds %v", result["next_offset"])
	}
	result = call(t, e, "pty.read", Args{ID: 1, Offset: 123 + 64<<10}).(map[string]any)
	if result["next_offset"] != uint64(123+128<<10) {
		t.Fatal("read cursor did not advance")
	}
	if _, err := e.Handle(context.Background(), "hello", json.RawMessage(`{"version":2}`)); err == nil {
		t.Fatal("unknown protocol accepted")
	}
}
func TestRealPTYAndPause(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix tty command")
	}
	e := New(testConfig())
	defer e.Close()
	opened := call(t, e, "pty.open", Args{Shell: "/bin/sh", Cols: 90, Rows: 30}).(map[string]any)
	id := opened["id"].(uint32)
	call(t, e, "pty.write", Args{ID: id, Data: []byte("test -t 0 && printf 'REAL_PTY_OK\\n'; stty size\n")})
	deadline := time.Now().Add(3 * time.Second)
	for {
		result := call(t, e, "pty.read", Args{ID: id}).(map[string]any)
		output := string(result["data"].([]byte))
		if strings.Contains(output, "REAL_PTY_OK\r\n") && strings.Contains(output, "30 90") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("real terminal response missing %q", output)
		}
		time.Sleep(10 * time.Millisecond)
	}
	call(t, e, "pty.resize", Args{ID: id, Cols: 100, Rows: 40})
	e.SetPaused(true)
	result := call(t, e, "pty.read", Args{ID: id}).(map[string]any)
	if result["exited"] == true {
		t.Fatal("pause terminated terminal")
	}
	raw, _ := json.Marshal(Args{ID: id, Data: []byte("echo forbidden\n")})
	if _, err := e.Handle(context.Background(), "pty.write", raw); err == nil {
		t.Fatal("paused terminal accepted input")
	}
	if len(call(t, e, "pty.list", Args{}).([]map[string]any)) != 1 {
		t.Fatal("paused terminal disappeared")
	}
	e.SetPaused(false)
	call(t, e, "pty.write", Args{ID: id, Data: []byte("printf 'RESUMED_OK\\n'\n")})
	deadline = time.Now().Add(time.Second)
	for {
		result = call(t, e, "pty.read", Args{ID: id}).(map[string]any)
		if strings.Contains(string(result["data"].([]byte)), "RESUMED_OK\r\n") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not survive pause")
		}
		time.Sleep(time.Millisecond)
	}
	e.SetPaused(true)
	_ = e.Close()
	deadline = time.Now().Add(2 * time.Second)
	for {
		s := e.sessions[id]
		s.mu.Lock()
		done := s.done
		s.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("close did not terminate terminal")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestCloseCancelsExec(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sleep")
	}
	e := New(testConfig())
	defer e.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = e.Handle(context.Background(), "exec", json.RawMessage(`{"command":"/bin/sh","args":["-c","sleep 20"]}`))
	}()
	deadline := time.Now().Add(time.Second)
	for {
		e.mu.Lock()
		active := len(e.running) > 0
		e.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("process not started")
		}
		time.Sleep(time.Millisecond)
	}
	_ = e.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("close did not cancel exec")
	}
}

func TestPauseLetsExistingExecFinish(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell fixture")
	}
	e := New(testConfig())
	defer e.Close()
	type response struct {
		value any
		err   error
	}
	done := make(chan response, 1)
	go func() {
		value, err := e.Handle(context.Background(), "exec", json.RawMessage(`{"command":"/bin/sh","args":["-c","sleep 0.1; printf completed"]}`))
		done <- response{value, err}
	}()
	deadline := time.Now().Add(time.Second)
	for {
		e.mu.Lock()
		active := len(e.running) > 0
		e.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("exec did not start")
		}
		time.Sleep(time.Millisecond)
	}
	e.SetPaused(true)
	if _, err := e.Handle(context.Background(), "exec", json.RawMessage(`{"command":"/bin/sh"}`)); err == nil {
		t.Fatal("pause accepted new execution")
	}
	select {
	case result := <-done:
		if result.err != nil {
			t.Fatal(result.err)
		}
		value := result.value.(map[string]any)
		if value["stdout"] != "completed" || value["exit_code"] != 0 {
			t.Fatalf("pause interrupted existing execution %v", value)
		}
	case <-time.After(time.Second):
		t.Fatal("existing execution did not finish")
	}
}
