package brotoupdate

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The copied test executable supplies a real child process and a tiny health
// protocol. No production service, account, socket or release is involved.
func init() {
	if os.Getenv("CIALAI_BROTO_SUPERVISOR_HELPER") != "1" || len(os.Args) < 2 {
		return
	}
	mode := os.Args[1]
	if mode != "serve" && mode != "status" && mode != "encerrar-servico" && mode != "worker" {
		return
	}
	state := ""
	for i := 1; i+1 < len(os.Args); i++ {
		if os.Args[i] == "--state-dir" {
			state = os.Args[i+1]
		}
	}
	if state == "" {
		os.Exit(10)
	}
	pidFile := filepath.Join(state, "pid")
	pid := strconv.Itoa(os.Getpid())
	switch mode {
	case "status":
		if _, e := os.Stat(filepath.Join(state, "unhealthy")); e == nil {
			os.Exit(11)
		}
		raw, e := os.ReadFile(pidFile)
		if e != nil {
			os.Exit(12)
		}
		fmt.Print(string(raw))
		os.Exit(0)
	case "encerrar-servico":
		raw, e := os.ReadFile(pidFile)
		if e != nil {
			os.Exit(13)
		}
		if os.WriteFile(filepath.Join(state, "stop-"+strings.TrimSpace(string(raw))), nil, 0600) != nil {
			os.Exit(14)
		}
		os.Exit(0)
	case "worker":
		until := time.Now().Add(10 * time.Second)
		for time.Now().Before(until) {
			if os.WriteFile(filepath.Join(state, "heartbeat"), []byte(strconv.FormatInt(time.Now().UnixNano(), 10)), 0600) != nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(0)
	case "serve":
		// Windows can reuse a PID after restart; a previous instance's stop
		// marker is not a shutdown request for this newly created process.
		_ = os.Remove(filepath.Join(state, "stop-"+pid))
		executable, _ := os.Executable()
		version := filepath.Base(filepath.Dir(executable))
		if version == "crash" {
			_ = os.WriteFile(filepath.Join(state, "candidate-started"), []byte("1"), 0600)
			os.Exit(7)
		}
		if version != "unready" {
			if os.WriteFile(pidFile, []byte(pid), 0600) != nil {
				os.Exit(15)
			}
		}
		if version == "tree" {
			worker := exec.Command(executable, "worker", "--state-dir", state)
			worker.Stdout = os.Stdout
			worker.Stderr = os.Stderr
			if worker.Start() != nil {
				os.Exit(16)
			}
			go worker.Wait()
			_ = os.WriteFile(filepath.Join(state, "worker-pid"), []byte(strconv.Itoa(worker.Process.Pid)), 0600)
		}
		until := time.Now().Add(15 * time.Second)
		for time.Now().Before(until) {
			if _, e := os.Stat(filepath.Join(state, "stop-"+pid)); e == nil {
				_ = os.Remove(filepath.Join(state, "stop-"+pid))
				raw, _ := os.ReadFile(pidFile)
				if string(raw) == pid {
					_ = os.Remove(pidFile)
				}
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(17)
	}
}
func supervisorFixture(t *testing.T, version string) (string, string, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "install")
	if e := ProtectDirectory(root); e != nil {
		t.Fatal(e)
	}
	state := t.TempDir()
	source, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(source)
	if e != nil {
		t.Fatal(e)
	}
	binary := filepath.Join(root, "releases", version, filepath.Base(source))
	if e = os.MkdirAll(filepath.Dir(binary), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(binary, raw, 0700); e != nil {
		t.Fatal(e)
	}
	return root, state, binary
}
func waitSupervisorFile(t *testing.T, path string, predicate func(string) bool) string {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		raw, _ := os.ReadFile(path)
		if predicate(string(raw)) {
			return string(raw)
		}
		if time.Now().After(deadline) {
			t.Fatal("supervisor state did not converge", filepath.Base(path), string(raw))
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func startSupervisorTest(t *testing.T, root, state, binary string) (context.CancelFunc, <-chan error) {
	t.Helper()
	t.Setenv("CIALAI_BROTO_SUPERVISOR_HELPER", "1")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	if e := atomicPointerWrite(filepath.Join(root, "current-path"), []byte(binary+"\n")); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Supervise(ctx, SupervisorConfig{Root: root, StateDir: state, pollInterval: 20 * time.Millisecond, readyTimeout: 5 * time.Second, stopTimeout: 300 * time.Millisecond})
	}()
	t.Cleanup(cancel)
	return cancel, done
}
func TestSupervisorRecoversFailedCandidateAfterRollback(t *testing.T) {
	for _, failure := range []string{"crash", "missing"} {
		t.Run(failure, func(t *testing.T) {
			root, state, good := supervisorFixture(t, "good")
			candidate := filepath.Join(root, "releases", failure, filepath.Base(good))
			if failure == "crash" {
				raw, _ := os.ReadFile(good)
				_ = os.MkdirAll(filepath.Dir(candidate), 0700)
				if e := os.WriteFile(candidate, raw, 0700); e != nil {
					t.Fatal(e)
				}
			}
			cancel, done := startSupervisorTest(t, root, state, good)
			active := filepath.Join(root, "active-path")
			waitSupervisorFile(t, active, func(value string) bool { return strings.HasPrefix(value, good+"\n") })
			ctx, stop := context.WithTimeout(context.Background(), 8*time.Second)
			defer stop()
			result := Result{PreviousBinary: good, NextBinary: candidate, CurrentPointer: filepath.Join(root, "current-path"), StateDir: state}
			activated := make(chan error, 1)
			go func() { activated <- activateSupervised(ctx, result) }()
			if failure == "crash" {
				waitSupervisorFile(t, filepath.Join(state, "candidate-started"), func(value string) bool { return value != "" })
			} else {
				waitSupervisorFile(t, active, func(value string) bool { return value == "" })
				time.Sleep(200 * time.Millisecond)
			}
			select {
			case e := <-done:
				t.Fatal("supervisor exited for the failed candidate", e)
			default:
			}
			stop()
			select {
			case e := <-activated:
				if e == nil {
					t.Fatal("failed candidate was accepted")
				}
			case <-time.After(8 * time.Second):
				t.Fatal("rollback did not restore a healthy service")
			}
			raw, e := os.ReadFile(active)
			if e != nil || !strings.HasPrefix(string(raw), good+"\n") {
				t.Fatal("rollback returned before previous version was healthy", e, string(raw))
			}
			fields := strings.Fields(string(raw))
			pid, e := probeServicePID(context.Background(), good, state)
			if e != nil || len(fields) < 2 || fields[1] != strconv.Itoa(pid) {
				t.Fatal("restored health record did not identify the live child", e)
			}
			select {
			case e := <-done:
				t.Fatal("supervisor exited instead of recovering", e)
			default:
			}
			cancel()
			select {
			case e := <-done:
				if e != nil {
					t.Fatal(e)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("supervisor did not stop")
			}
		})
	}
}
func TestSupervisorFallbackStopsOwnedDescendants(t *testing.T) {
	root, state, binary := supervisorFixture(t, "tree")
	cancel, done := startSupervisorTest(t, root, state, binary)
	waitSupervisorFile(t, filepath.Join(root, "active-path"), func(v string) bool { return strings.HasPrefix(v, binary+"\n") })
	waitSupervisorFile(t, filepath.Join(state, "worker-pid"), func(v string) bool { return v != "" })
	waitSupervisorFile(t, filepath.Join(state, "heartbeat"), func(v string) bool { return v != "" })
	if e := os.WriteFile(filepath.Join(state, "unhealthy"), nil, 0600); e != nil {
		t.Fatal(e)
	}
	cancel()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("fallback did not finish")
	}
	before, _ := os.ReadFile(filepath.Join(state, "heartbeat"))
	time.Sleep(200 * time.Millisecond)
	after, _ := os.ReadFile(filepath.Join(state, "heartbeat"))
	if string(before) != string(after) {
		t.Fatal("fallback left a descendant executing")
	}
}
