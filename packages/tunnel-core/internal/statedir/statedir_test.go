// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
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
