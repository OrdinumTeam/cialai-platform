// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestPrepareCreatesPrivateStablePaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tunnel")
	paths, err := Prepare(root)
	if err != nil {
		t.Fatal(err)
	}
	if paths.Root != root || paths.TSNet != filepath.Join(root, "tsnet") || paths.Devices != filepath.Join(root, "devices.json") || paths.PID != filepath.Join(root, "pid") {
		t.Fatalf("unexpected paths: %#v", paths)
	}
	if runtime.GOOS != "windows" {
		for _, path := range []string{paths.Root, paths.TSNet} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0o700 {
				t.Fatalf("%s is not private: %v %v", path, info, err)
			}
		}
	}
}

func TestAtomicWriteStaysInsideRootAndUsesPrivateFileMode(t *testing.T) {
	paths, err := Prepare(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	if err := paths.WriteAtomic(paths.Identity, []byte(`{"id":"desktop-1"}`)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(paths.Identity)
	if err != nil || string(data) != `{"id":"desktop-1"}` {
		t.Fatalf("bad atomic content: %q, %v", data, err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(paths.Identity)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("file mode is %o", info.Mode().Perm())
		}
	}
	if err := paths.WriteAtomic(filepath.Join(paths.Root, "..", "escape"), []byte("no")); err == nil {
		t.Fatal("write escaped state root")
	}
}

// A reader holding the target open makes a Windows rename fail until its
// handle closes; Rename waits for it instead of failing the write.
func TestRenameWaitsForAnOpenReader(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "state.json")
	source := filepath.Join(dir, ".next")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(100 * time.Millisecond)
		_ = reader.Close()
	}()
	err = Rename(source, target)
	<-released
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "new" {
		t.Fatalf("target holds %q, %v", data, err)
	}
	if _, err := os.Stat(source); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("source still exists: %v", err)
	}
}

// Readers of a state file that is being replaced must always see a whole
// version; on Windows ReadFile also waits out the sharing violations of the
// replacement.
func TestReadFileWhileWriteAtomicReplaces(t *testing.T) {
	paths, err := Prepare(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	versions := []string{`{"version":"a"}`, `{"version":"b"}`}
	if err := paths.WriteAtomic(paths.Devices, []byte(versions[0])); err != nil {
		t.Fatal(err)
	}
	const rounds = 200
	writeErr := make(chan error, 1)
	go func() {
		for index := range rounds {
			if err := paths.WriteAtomic(paths.Devices, []byte(versions[index%2])); err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- nil
	}()
	for range rounds {
		data, err := ReadFile(paths.Devices)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != versions[0] && string(data) != versions[1] {
			t.Fatalf("read a partial state file: %q", data)
		}
	}
	if err := <-writeErr; err != nil {
		t.Fatal(err)
	}
}

func TestLockRejectsLiveOwnerAndReplacesStaleOwner(t *testing.T) {
	paths, err := Prepare(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := Acquire(paths, 101, func(pid int) bool { return pid == 101 })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(paths, 202, func(pid int) bool { return pid == 101 }); !errors.Is(err, ErrLocked) {
		t.Fatalf("expected live lock, got %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	stale, err := Acquire(paths, 303, func(int) bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	if err := stale.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseDoesNotRemoveAReplacementLock(t *testing.T) {
	paths, err := Prepare(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(paths, 101, func(int) bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	if err := paths.WriteAtomic(paths.PID, []byte(`{"pid":202,"nonce":"replacement"}`)); err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.PID); err != nil {
		t.Fatal("release removed another owner lock")
	}
}
