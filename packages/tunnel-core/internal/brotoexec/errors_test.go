package brotoexec

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutionDiagnosticsContainOnlySafeReasons(t *testing.T) {
	e := New(Config{AllowExec: true, AllowPrivileged: true})
	defer e.Close()
	check := func(a Args, code string) {
		t.Helper()
		raw, _ := json.Marshal(a)
		_, err := e.Handle(context.Background(), "exec", raw)
		if err == nil {
			t.Fatal("expected error")
		}
		message := Diagnostic(err)
		if !strings.HasPrefix(message, code+":") || strings.Contains(message, "PRIVATE_SENTINEL") {
			t.Fatalf("unsafe or incorrect diagnostic %q", message)
		}
	}
	check(Args{Command: "PRIVATE_SENTINEL-command", Dir: filepath.Join(t.TempDir(), "PRIVATE_SENTINEL-dir")}, "working_directory_unavailable")
	check(Args{Command: "PRIVATE_SENTINEL-command"}, "executable_unavailable")
	e.SetPaused(true)
	check(Args{Command: "PRIVATE_SENTINEL-command"}, "executor_paused")
	if message := Diagnostic(errors.New("PRIVATE_SENTINEL internal error")); strings.Contains(message, "PRIVATE_SENTINEL") || !strings.HasPrefix(message, "operation_failed:") {
		t.Fatal("unknown error content escaped sanitization")
	}
}
