package brotoexec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func digest(p []byte) string { h := sha256.Sum256(p); return hex.EncodeToString(h[:]) }
func fileExecutor(t *testing.T) (*Executor, string) {
	t.Helper()
	dir := t.TempDir()
	e := New(Config{AllowFiles: true, FileRoots: []string{dir}, MaxFileMB: 1})
	t.Cleanup(func() { e.Close() })
	return e, dir
}
func reject(t *testing.T, e *Executor, verb string, a any) {
	t.Helper()
	raw, _ := json.Marshal(a)
	if _, err := e.Handle(context.Background(), verb, raw); err == nil {
		t.Fatalf("accepted %s", verb)
	}
}
func TestFilesIntegrityConfinementAndPause(t *testing.T) {
	e, dir := fileExecutor(t)
	path := filepath.Join(dir, "file.txt")
	a := fileArgs{Path: path, Data: []byte("first"), TransferID: "one", ChunkSHA256: digest([]byte("first")), Size: 11}
	call(t, e, "files.put", a)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("partial file visible")
	}
	reject(t, e, "files.put", fileArgs{Path: path, Offset: 5, Data: []byte("other"), TransferID: "two"})
	a.Offset = 5
	a.Data = []byte("second")
	a.ChunkSHA256 = digest(a.Data)
	a.Final = true
	a.SHA256 = digest([]byte("firstsecond"))
	out := call(t, e, "files.put", a).(map[string]any)
	if out["complete"] != true {
		t.Fatal(out)
	}
	reject(t, e, "files.put", fileArgs{Path: path, Data: []byte("x"), Final: true, SHA256: digest([]byte("x"))})
	g := fileArgs{Path: path, Length: 5, TransferID: "download"}
	first := call(t, e, "files.get", g).(map[string]any)
	if string(first["data"].([]byte)) != "first" {
		t.Fatal(first)
	}
	g.Offset = 5
	g.Length = 10
	last := call(t, e, "files.get", g).(map[string]any)
	if last["sha256"] != digest([]byte("firstsecond")) {
		t.Fatal(last)
	}
	for _, path := range []string{filepath.Join(dir, "..", "escape"), filepath.Join(dir, "CON.txt"), filepath.Join(dir, "a:stream")} {
		reject(t, e, "files.stat", fileArgs{Path: path})
	}
	bad := filepath.Join(dir, "bad")
	reject(t, e, "files.put", fileArgs{Path: bad, Data: []byte("bad"), Final: true, SHA256: digest([]byte("different"))})
	if _, err := os.Stat(bad + ".cialai-part"); !os.IsNotExist(err) {
		t.Fatal("bad hash retained partial")
	}
	paused := filepath.Join(dir, "paused")
	call(t, e, "files.put", fileArgs{Path: paused, Data: []byte("x"), TransferID: "p"})
	e.SetPaused(true)
	if _, err := os.Stat(paused + ".cialai-part"); !os.IsNotExist(err) {
		t.Fatal("pause retained partial")
	}
	reject(t, e, "files.put", fileArgs{Path: paused})
	e.SetPaused(false)
	reject(t, e, "files.put", fileArgs{Path: filepath.Join(dir, "large"), Size: 2 << 20})
}
func TestFilesRejectSymlinkEscapeAndSystemRoots(t *testing.T) {
	e, dir := fileExecutor(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		if runtime.GOOS == "windows" {
			t.Log("symlink creation unavailable under Windows user token")
		} else {
			t.Fatal(err)
		}
	} else {
		reject(t, e, "files.stat", fileArgs{Path: filepath.Join(dir, "link", "secret")})
		reject(t, e, "files.put", fileArgs{Path: filepath.Join(dir, "link", "new"), Data: []byte("x")})
	}
	e.config.FileRoots = []string{string(filepath.Separator)}
	reject(t, e, "files.stat", fileArgs{Path: dir})
	e.config.AllowFiles = false
	reject(t, e, "files.list", fileArgs{Path: dir})
}
func TestFilesDownloadDetectsMutationAndCancel(t *testing.T) {
	e, dir := fileExecutor(t)
	path := filepath.Join(dir, "source")
	os.WriteFile(path, []byte("abcdef"), 0600)
	a := fileArgs{Path: path, Length: 2, TransferID: "d"}
	call(t, e, "files.get", a)
	os.WriteFile(path, []byte("changed-length"), 0600)
	a.Offset = 2
	reject(t, e, "files.get", a)
	if len(e.downloads) != 0 {
		t.Fatal("download not closed")
	}
	a.Offset = 0
	call(t, e, "files.get", a)
	call(t, e, "files.cancel", a)
	if len(e.downloads) != 0 {
		t.Fatal("cancel retained download")
	}
}
func TestExecStreamAndCancel(t *testing.T) {
	c := testConfig()
	c.MaxDuration = 10 * time.Second
	c.MaxOutput = 2
	outputs := make(chan []byte, 32)
	c.OnExecOutput = func(_ uint64, _ string, p []byte) { outputs <- p }
	e := New(c)
	defer e.Close()
	a := Args{Command: "/bin/sh", Args: []string{"-c", "printf streamed; sleep 8"}, Stream: true}
	if runtime.GOOS == "windows" {
		a.Command = "powershell.exe"
		a.Args = []string{"-NoProfile", "-NonInteractive", "-Command", "[Console]::Write('streamed'); Start-Sleep -Seconds 8"}
	}
	raw, _ := json.Marshal(a)
	done := make(chan any, 1)
	go func() {
		r, err := e.HandleCall(context.Background(), 77, "exec", raw)
		if err != nil {
			done <- err
		} else {
			done <- r
		}
	}()
	var output bytes.Buffer
	deadline := time.After(5 * time.Second)
	for !strings.Contains(output.String(), "streamed") {
		select {
		case p := <-outputs:
			output.Write(p)
		case <-deadline:
			t.Fatal("no streaming output")
		}
	}
	call(t, e, "exec.cancel", Args{CallID: 77})
	select {
	case r := <-done:
		out, ok := r.(map[string]any)
		if !ok || out["truncated"] != true {
			t.Fatal(r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not stop tree")
	}
}
