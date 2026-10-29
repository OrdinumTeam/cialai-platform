//go:build windows

package brotoexec

import (
	"context"
	"encoding/json"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func windowsConfig() Config { c := testConfig(); c.MaxDuration = 30 * time.Second; return c }
func TestWindowsPrivilegedAccountRequiresExplicitOptIn(t *testing.T) {
	if !privileged() {
		t.Skip("requires an elevated token to exercise the production guard")
	}
	raw := json.RawMessage(`{"command":"cmd.exe","args":["/d","/c","echo explicit-opt-in"]}`)
	guarded := New(Config{AllowExec: true})
	defer guarded.Close()
	if _, err := guarded.Handle(context.Background(), "exec", raw); err == nil || !strings.HasPrefix(Diagnostic(err), "execution_account_privileged:") {
		t.Fatal("default executor accepted an elevated account", err)
	}
	allowed := New(windowsConfig())
	defer allowed.Close()
	result := call(t, allowed, "exec", Args{Command: "cmd.exe", Args: []string{"/d", "/c", "echo explicit-opt-in"}}).(map[string]any)
	if strings.TrimSpace(result["stdout"].(string)) != "explicit-opt-in" || result["exit_code"] != 0 {
		t.Fatal("explicit trusted opt-in did not execute", result)
	}
}
func windowsWaitFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if raw, err := os.ReadFile(path); err == nil && len(raw) > 0 {
			return string(raw)
		}
		if time.Now().After(deadline) {
			t.Fatal("Windows child did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type windowsExecResult struct {
	value any
	err   error
}

func windowsStartExec(e *Executor, a Args) <-chan windowsExecResult {
	done := make(chan windowsExecResult, 1)
	raw, _ := json.Marshal(a)
	go func() {
		value, err := e.Handle(context.Background(), "exec", raw)
		done <- windowsExecResult{value, err}
	}()
	return done
}
func windowsAwaitExec(t *testing.T, done <-chan windowsExecResult) map[string]any {
	t.Helper()
	select {
	case result := <-done:
		if result.err != nil {
			t.Fatal(result.err)
		}
		return result.value.(map[string]any)
	case <-time.After(15 * time.Second):
		t.Fatal("Windows execution did not return")
		return nil
	}
}

func TestWindowsExecResultsAndDeadline(t *testing.T) {
	e := New(windowsConfig())
	defer e.Close()
	result := call(t, e, "exec", Args{Command: "cmd.exe", Args: []string{"/d", "/c", "echo stdout-value & echo stderr-value 1>&2 & exit /b 7"}}).(map[string]any)
	if strings.TrimSpace(result["stdout"].(string)) != "stdout-value" || strings.TrimSpace(result["stderr"].(string)) != "stderr-value" || result["exit_code"] != 7 {
		t.Fatalf("unexpected execution result %v", result)
	}
	started := time.Now()
	result = call(t, e, "exec", Args{Command: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"}, TimeoutMS: 100}).(map[string]any)
	if result["timed_out"] != true || time.Since(started) > 15*time.Second {
		t.Fatalf("Windows timeout not enforced %v", result)
	}
}

func TestWindowsPauseLetsExistingExecFinish(t *testing.T) {
	e := New(windowsConfig())
	defer e.Close()
	ready := filepath.Join(t.TempDir(), "ready")
	release := filepath.Join(t.TempDir(), "release")
	done := windowsStartExec(e, Args{Command: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", `[IO.File]::WriteAllText($env:BROTO_READY,'ready'); while(!(Test-Path -LiteralPath $env:BROTO_RELEASE)){Start-Sleep -Milliseconds 20}; [Console]::Out.Write('completed')`}, Env: map[string]string{"BROTO_READY": ready, "BROTO_RELEASE": release}})
	windowsWaitFile(t, ready)
	e.SetPaused(true)
	if _, err := e.Handle(context.Background(), "exec", json.RawMessage(`{"command":"cmd.exe"}`)); err == nil {
		t.Fatal("paused Windows executor accepted new command")
	}
	if err := os.WriteFile(release, []byte("continue"), 0600); err != nil {
		t.Fatal(err)
	}
	result := windowsAwaitExec(t, done)
	if result["stdout"] != "completed" || result["exit_code"] != 0 {
		t.Fatalf("pause interrupted existing execution %v", result)
	}
}

func TestWindowsCloseTerminatesExecTree(t *testing.T) {
	e := New(windowsConfig())
	defer e.Close()
	ready := filepath.Join(t.TempDir(), "child-pid")
	done := windowsStartExec(e, Args{Command: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", `$p=Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru; [IO.File]::WriteAllText($env:BROTO_READY,[string]$p.Id); Start-Sleep -Seconds 30`}, Env: map[string]string{"BROTO_READY": ready}})
	pid, err := strconv.Atoi(windowsWaitFile(t, ready))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if err = e.Close(); err != nil {
		t.Fatal(err)
	}
	result := windowsAwaitExec(t, done)
	if result["exit_code"] == 0 {
		t.Fatal("closed Windows command exited successfully")
	}
	status, err := windows.WaitForSingleObject(handle, 5000)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateProcess(handle, 1)
		t.Fatal("Close left a child process alive", status, err)
	}
}

func windowsReadUntil(t *testing.T, e *Executor, id uint32, marker string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		result := call(t, e, "pty.read", Args{ID: id}).(map[string]any)
		if strings.Contains(string(result["data"].([]byte)), marker) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("Windows terminal marker missing", marker)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestWindowsPauseKeepsPTYAndCloseTerminates(t *testing.T) {
	t.Setenv("BROTO_PTY_MARKER", "PTY_ALIVE_731296")
	e := New(windowsConfig())
	defer e.Close()
	opened := call(t, e, "pty.open", Args{Shell: "cmd.exe", Cols: 80, Rows: 24}).(map[string]any)
	id := opened["id"].(uint32)
	call(t, e, "pty.resize", Args{ID: id, Cols: 100, Rows: 30})
	e.SetPaused(true)
	if call(t, e, "pty.read", Args{ID: id}).(map[string]any)["exited"] == true {
		t.Fatal("pause killed ConPTY")
	}
	raw, _ := json.Marshal(Args{ID: id, Data: []byte("echo forbidden\r\n")})
	if _, err := e.Handle(context.Background(), "pty.write", raw); err == nil {
		t.Fatal("paused ConPTY accepted input")
	}
	if len(call(t, e, "pty.list", Args{}).([]map[string]any)) != 1 {
		t.Fatal("paused ConPTY disappeared")
	}
	e.SetPaused(false)
	call(t, e, "pty.write", Args{ID: id, Data: []byte("echo %BROTO_PTY_MARKER%\r\n")})
	windowsReadUntil(t, e, id, "PTY_ALIVE_731296")
	e.SetPaused(true)
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		s := e.sessions[id]
		s.mu.Lock()
		done := s.done
		s.mu.Unlock()
		if done {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("Close left ConPTY running")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Run on windows-2022 as well as modern Windows. The final expanded marker
// occurs after more than one RPC page; the typed command cannot satisfy it.
func TestWindowsConPTYDrain(t *testing.T) {
	t.Setenv("BROTO_DRAIN_FINAL", "COMPLETE_938172")
	e := New(windowsConfig())
	defer e.Close()
	opened := call(t, e, "pty.open", Args{Shell: "cmd.exe", Cols: 120, Rows: 24}).(map[string]any)
	id := opened["id"].(uint32)
	call(t, e, "pty.write", Args{ID: id, Data: []byte("for /L %i in (1,1,1500) do @echo drain-line-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz\r\necho CONPTY_FINAL_%BROTO_DRAIN_FINAL%\r\nexit\r\n")})
	deadline := time.Now().Add(60 * time.Second)
	var output strings.Builder
	var offset uint64
	for {
		result := call(t, e, "pty.read", Args{ID: id, Offset: offset}).(map[string]any)
		if result["offset"].(uint64) != offset {
			t.Fatalf("ConPTY ring dropped bytes before offset %d", offset)
		}
		data := result["data"].([]byte)
		if len(data) > 64<<10 {
			t.Fatal("PTY RPC exceeded page bound")
		}
		output.Write(data)
		offset = result["next_offset"].(uint64)
		if result["exited"] == true && offset == result["total_offset"].(uint64) {
			if output.Len() <= 64<<10 {
				t.Fatalf("fixture did not cross an RPC page: %d", output.Len())
			}
			if !strings.Contains(output.String(), "CONPTY_FINAL_COMPLETE_938172") {
				t.Fatal("final ConPTY output was lost")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("ConPTY did not drain and close")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func TestServicePrivilegesAreRemovedBeforeAnyCommand(t *testing.T) {
	privileged()
	for _, name := range riskyServicePrivileges {
		if holdsPrivilege(windows.GetCurrentProcessToken(), name) {
			t.Fatalf("%s survived for the shells this process starts", name)
		}
	}
}
