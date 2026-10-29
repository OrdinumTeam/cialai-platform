package brotoexec

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUploadOrphanRecoveryAndLiveOwnerProtection(t *testing.T) {
	e, dir := fileExecutor(t)
	path := filepath.Join(dir, "recovered")
	part := path + ".cialai-part"
	if err := os.WriteFile(part, []byte("orphaned bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(fileArgs{Path: path, Data: []byte("new"), Size: 3, Final: true, SHA256: digest([]byte("new")), TransferID: "new"})
	if _, err := e.Handle(context.Background(), "files.put", raw); err != nil {
		t.Fatalf("orphan blocked new transfer: %v", err)
	}
	live := filepath.Join(dir, "live")
	call(t, e, "files.put", fileArgs{Path: live, Data: []byte("active"), Size: 12, TransferID: "owner"})
	other := New(e.config)
	defer other.Close()
	reject(t, other, "files.put", fileArgs{Path: live, Data: []byte("replacement"), Size: 11, Final: true, SHA256: digest([]byte("replacement")), TransferID: "intruder"})
	got, _ := os.ReadFile(live + ".cialai-part")
	if string(got) != "active" {
		t.Fatal("live transfer overwritten")
	}
}
func TestAbandonedUploadExpiresWithoutFurtherRequests(t *testing.T) {
	dir := t.TempDir()
	e := New(Config{AllowFiles: true, FileRoots: []string{dir}, transferIdleTimeout: 25 * time.Millisecond})
	defer e.Close()
	path := filepath.Join(dir, "abandoned")
	call(t, e, "files.put", fileArgs{Path: path, Data: []byte("partial"), Size: 100, TransferID: "gone"})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path + ".cialai-part"); os.IsNotExist(err) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("idle upload retained partial and destination lock")
}
func TestFileDiagnosticsAreActionableAndSanitized(t *testing.T) {
	e, dir := fileExecutor(t)
	cases := []struct {
		verb string
		a    fileArgs
		code string
	}{{"files.stat", fileArgs{Path: filepath.Join(dir, "PRIVATE_SENTINEL-missing")}, "file_not_found"}, {"files.put", fileArgs{Path: filepath.Join(dir, "PRIVATE_SENTINEL-large"), Size: 2 << 20}, "file_size_limit"}, {"files.put", fileArgs{Path: filepath.Join(dir, "PRIVATE_SENTINEL-hash"), Data: []byte("x"), Final: true, SHA256: "bad"}, "file_hash_mismatch"}, {"files.stat", fileArgs{Path: filepath.Join(dir, "..", "PRIVATE_SENTINEL")}, "file_outside_roots"}}
	for _, tc := range cases {
		raw, _ := json.Marshal(tc.a)
		_, err := e.Handle(context.Background(), tc.verb, raw)
		message := Diagnostic(err)
		if !strings.HasPrefix(message, tc.code+":") || strings.Contains(message, "PRIVATE_SENTINEL") {
			t.Errorf("%s diagnostic: %s", tc.code, message)
		}
	}
}

func TestUploadLockOwnerHelper(t *testing.T) {
	dir := os.Getenv("CIALAI_TEST_TRANSFER_OWNER")
	if dir == "" {
		return
	}
	e := New(Config{AllowFiles: true, FileRoots: []string{dir}})
	call(t, e, "files.put", fileArgs{Path: filepath.Join(dir, "cross-process"), Data: []byte("owner"), Size: 100, TransferID: "child"})
	fmt.Println("upload-lock-ready")
	select {}
}
func TestUploadLockSurvivesLiveOwnerAndRecoversAfterCrash(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestUploadLockOwnerHelper$")
	cmd.Env = append(os.Environ(), "CIALAI_TEST_TRANSFER_OWNER="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(out).ReadString('\n'); ready <- line }()
	select {
	case line := <-ready:
		if line != "upload-lock-ready\n" {
			t.Fatalf("helper failed: %s", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("helper did not start")
	}
	e := New(Config{AllowFiles: true, FileRoots: []string{dir}})
	defer e.Close()
	path := filepath.Join(dir, "cross-process")
	a := fileArgs{Path: path, Data: []byte("replacement"), Size: 11, TransferID: "parent", Final: true, SHA256: digest([]byte("replacement"))}
	reject(t, e, "files.put", a)
	bytes, _ := os.ReadFile(path + ".cialai-part")
	if string(bytes) != "owner" {
		t.Fatal("live owner's partial changed")
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	call(t, e, "files.put", a)
	bytes, _ = os.ReadFile(path)
	if string(bytes) != "replacement" {
		t.Fatal("crashed owner's partial blocked recovery")
	}
}
