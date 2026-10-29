package brotoclient

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Control socket fixtures use a short private directory under the user's home,
// even when the Go build uses TMPDIR=/tmp.
func privateControlDir(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(home, ".bc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestControlLifecycleAndSingleOwner(t *testing.T) {
	dir := privateControlDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, err := New(ctx, Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err = New(ctx, Config{Dir: dir}); err == nil {
		t.Fatal("second daemon obtained same state")
	}
	if runtime.GOOS != "windows" {
		t.Setenv("CIALAI_BROTO_SOCKET", filepath.Join(dir, "c.sock"))
	} else {
		t.Setenv("CIALAI_BROTO_SOCKET", `\\.\pipe\cialai-broto-test-lifecycle-`+strconv.Itoa(os.Getpid()))
	}
	done := make(chan error, 1)
	go func() { done <- client.ServeControl(ctx) }()
	deadline := time.Now().Add(time.Second)
	for {
		var raw json.RawMessage
		raw, err = ControlCall(ctx, dir, "broto.status", nil)
		if err == nil {
			var status Status
			if json.Unmarshal(raw, &status) != nil || status.PID != os.Getpid() || status.ParentPID != os.Getppid() {
				t.Fatal("status did not identify the serving daemon")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	for _, step := range []struct{ method, state string }{{"broto.pause", "paused"}, {"broto.resume", "disconnected"}, {"broto.disconnect", "disconnected"}} {
		raw, err := ControlCall(ctx, dir, step.method, nil)
		if err != nil {
			t.Fatal(err)
		}
		var s Status
		if json.Unmarshal(raw, &s) != nil || s.State != step.state {
			t.Fatalf("unexpected state %s", raw)
		}
	}
	if _, err = ControlCall(ctx, dir, "broto.connect", map[string]string{"pairing": "invalid-secret"}); err == nil {
		t.Fatal("invalid pairing accepted")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("control did not stop")
	}
}

func TestControlShutdown(t *testing.T) {
	dir := privateControlDir(t)
	if runtime.GOOS != "windows" {
		t.Setenv("CIALAI_BROTO_SOCKET", filepath.Join(dir, "shutdown.sock"))
	} else {
		t.Setenv("CIALAI_BROTO_SOCKET", `\\.\pipe\cialai-broto-test-shutdown-`+strconv.Itoa(os.Getpid()))
	}
	client, err := New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- client.ServeControl(context.Background()) }()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		if _, err = ControlCall(ctx, dir, "broto.status", nil); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatal("control listener stopped early", err)
		default:
		}
		if ctx.Err() != nil {
			t.Fatal("control did not start")
		}
		time.Sleep(time.Millisecond)
	}
	raw, err := ControlCall(ctx, dir, "broto.shutdown", nil)
	if err != nil {
		t.Fatal("shutdown response lost", err)
	}
	var answer struct {
		OK bool `json:"ok"`
	}
	if json.Unmarshal(raw, &answer) != nil || !answer.OK {
		t.Fatal("shutdown did not acknowledge", string(raw))
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("base cancellation did not stop the control listener")
	}
	if client.base.Err() == nil {
		t.Fatal("shutdown left the client running")
	}
	if _, err = os.Stat(filepath.Join(dir, "identity.key")); err != nil {
		t.Fatal("graceful shutdown removed persistent identity")
	}
}

func TestReverseWireExecPauseDisconnect(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix command fixture")
	}
	client, err := New(context.Background(), Config{Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	local, remote := net.Pipe()
	defer remote.Close()
	_ = remote.SetDeadline(time.Now().Add(5 * time.Second))
	done := make(chan error, 1)
	go func() { done <- client.serve(context.Background(), 0, local, "test-token", pathmgr.Status{}) }()
	reader := bufio.NewReader(remote)
	request, err := http.ReadRequest(reader)
	if err != nil {
		t.Fatal(err)
	}
	if request.URL.Path != "/broto" || request.Header.Get("Authorization") != "Bearer test-token" {
		t.Fatal("incorrect upgrade")
	}
	if _, err = remote.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: cialai-broto\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	event, err := brotorpc.Read(reader)
	if err != nil || event.Event != "paused" {
		t.Fatalf("initial state missing: %v", err)
	}
	if err = brotorpc.Write(remote, brotorpc.Message{ID: 99, Cmd: "hello", Args: json.RawMessage(`{"version":1}`)}); err != nil {
		t.Fatal(err)
	}
	hello, err := brotorpc.Read(reader)
	if err != nil || !hello.OK {
		t.Fatal("hello failed", err)
	}
	args := json.RawMessage(`{"command":"/bin/sh","args":["-c","printf wire-ok; printf wire-err >&2; exit 3"]}`)
	if err = brotorpc.Write(remote, brotorpc.Message{ID: 1, Cmd: "exec", Actor: "ai", Args: args}); err != nil {
		t.Fatal(err)
	}
	reply, err := brotorpc.Read(reader)
	if err != nil || !reply.OK {
		t.Fatalf("exec failed %s %v", reply.Error, err)
	}
	var result struct {
		Stdout string `json:"stdout"`
		Stderr string `json:"stderr"`
		Exit   int    `json:"exit_code"`
	}
	if json.Unmarshal(reply.Result, &result) != nil || result.Stdout != "wire-ok" || result.Stderr != "wire-err" || result.Exit != 3 {
		t.Fatalf("unexpected exec result %s", reply.Result)
	}
	client.Pause(true)
	event, err = brotorpc.Read(reader)
	if err != nil || event.Event != "paused" {
		t.Fatal("pause event missing")
	}
	if err = brotorpc.Write(remote, brotorpc.Message{ID: 2, Cmd: "exec", Args: args}); err != nil {
		t.Fatal(err)
	}
	reply, err = brotorpc.Read(reader)
	if err != nil || reply.OK {
		t.Fatal("paused executor accepted command")
	}
	disconnected := make(chan error, 1)
	go func() { disconnected <- client.Disconnect() }()
	event, err = brotorpc.Read(reader)
	if err != nil || event.Event != "disconnected" {
		t.Fatal("disconnect event missing")
	}
	if err = <-disconnected; err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("wire remained active after disconnect")
	}
}
func TestLocalPolicyAndAuditMetadata(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "policy.json"), []byte(`{"allowExec":false,"allowPTY":false}`), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.policy.AllowExec || client.policy.AllowPTY {
		t.Fatal("local ceiling ignored")
	}
	home, homeErr := os.UserHomeDir()
	if homeErr != nil || client.policy.Dir != home || !filepath.IsAbs(client.policy.Dir) {
		t.Fatal("policy did not retain the current user's home as initial directory")
	}
	for range 300 {
		client.audit(0, "ai", "secret-command")
	}
	status := client.Status()
	if len(status.Activity) != 256 {
		t.Fatal("activity not bounded")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "secret") || !strings.Contains(string(raw), `"actor":"ai"`) {
		t.Fatal("audit content incorrect")
	}
	info, _ := os.Stat(filepath.Join(dir, "audit.jsonl"))
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("audit permissions not private")
	}
}

func TestPTYSequenceSurvivesReconnectAndRestart(t *testing.T) {
	dir := t.TempDir()
	client, err := New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	first, err := client.allocatePTYID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.allocatePTYID()
	if err != nil || second <= first {
		t.Fatal("reconnect reused id")
	}
	if err = client.Close(); err != nil {
		t.Fatal(err)
	}
	client, err = New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	third, err := client.allocatePTYID()
	if err != nil || third <= second {
		t.Fatal("restart reused id")
	}
	client.sequence = ^uint32(0)
	if _, err = client.allocatePTYID(); err == nil {
		t.Fatal("id overflow accepted")
	}
}

func TestControlCallHonorsCallerDeadline(t *testing.T) {
	dir := privateControlDir(t)
	if runtime.GOOS != "windows" {
		t.Setenv("CIALAI_BROTO_SOCKET", filepath.Join(dir, "deadline.sock"))
	} else {
		t.Setenv("CIALAI_BROTO_SOCKET", `\\.\pipe\cialai-broto-test-deadline-`+strconv.Itoa(os.Getpid()))
	}
	listener, err := listenControl(ControlAddress(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err = ControlCall(ctx, dir, "broto.status", nil); err == nil {
		t.Fatal("silent control server returned success")
	}
	if time.Since(start) > time.Second {
		t.Fatal("caller deadline was expanded to the default timeout")
	}
	select {
	case conn := <-accepted:
		_ = conn.Close()
	default:
	}
}

func TestActivitySkipsPollingAndFoldsTyping(t *testing.T) {
	dir := t.TempDir()
	client, err := New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for range 20 {
		client.audit(0, "human", "pty.list")
		client.audit(0, "human", "pty.read")
	}
	client.audit(0, "human", "pty.open")
	for range 40 {
		client.audit(0, "human", "pty.write")
	}
	client.audit(0, "ai", "pty.write")
	var verbs []string
	for _, item := range client.Status().Activity {
		verbs = append(verbs, item.Actor+" "+item.Cmd)
	}
	if strings.Join(verbs, ",") != "human pty.open,human pty.write,ai pty.write" {
		t.Fatalf("activity = %v", verbs)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Count(string(raw), "\n"); lines != 3 || strings.Contains(string(raw), "pty.list") {
		t.Fatalf("audit file has %d lines: %s", lines, raw)
	}
}
