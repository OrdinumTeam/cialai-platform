// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestIsolatedLockOwner(t *testing.T) {
	root := os.Getenv("CIALAI_LOCK_TEST_ROOT")
	if root == "" {
		return
	}
	paths, err := Prepare(root)
	if err != nil {
		t.Fatal(err)
	}
	held, err := Acquire(paths, os.Getpid(), func(int) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("lock-ready")
	_, _ = io.Copy(io.Discard, os.Stdin)
	if err := held.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestProcessExitReleasesKernelOwnership(t *testing.T) {
	for _, abrupt := range []bool{false, true} {
		t.Run(fmt.Sprint("abrupt=", abrupt), func(t *testing.T) {
			paths, err := Prepare(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestIsolatedLockOwner$")
			cmd.Env = append(os.Environ(), "CIALAI_LOCK_TEST_ROOT="+paths.Root)
			stdin, _ := cmd.StdinPipe()
			stdout, _ := cmd.StdoutPipe()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			ready := make(chan string, 1)
			go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); ready <- line }()
			select {
			case line := <-ready:
				if line != "lock-ready\n" {
					t.Fatalf("child: %q", line)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("child startup timeout")
			}
			if _, err := Acquire(paths, os.Getpid(), func(int) bool { return false }); !errors.Is(err, ErrLocked) {
				t.Fatalf("active owner lost lock: %v", err)
			}
			if abrupt {
				_ = cmd.Process.Kill()
			} else {
				_ = stdin.Close()
			}
			_ = cmd.Wait()
			recovered, err := Acquire(paths, os.Getpid(), func(int) bool { return true })
			if err != nil {
				t.Fatalf("recover after exit: %v", err)
			}
			if err := recovered.Release(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConcurrentAcquisitionHasExactlyOneOwner(t *testing.T) {
	paths, err := Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan *Lock, 2)
	failures := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			held, err := Acquire(paths, os.Getpid(), func(int) bool { return false })
			results <- held
			failures <- err
		}()
	}
	close(start)
	var held []*Lock
	for range 2 {
		if lock := <-results; lock != nil {
			held = append(held, lock)
		}
	}
	defer func() {
		for _, lock := range held {
			_ = lock.Release()
		}
	}()
	if len(held) != 1 {
		t.Fatalf("got %d simultaneous owners", len(held))
	}
	for range 2 {
		if err := <-failures; err != nil && !errors.Is(err, ErrLocked) {
			t.Fatal(err)
		}
	}
}

func TestCorruptMetadataCannotKeepKernelLockAfterRelease(t *testing.T) {
	paths, _ := Prepare(t.TempDir())
	held, err := Acquire(paths, os.Getpid(), func(int) bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	if err := paths.WriteAtomic(paths.PID, []byte("incomplete")); err != nil {
		t.Fatal(err)
	}
	if err := held.Release(); err == nil {
		t.Fatal("corruption must be reported")
	}
	next, err := Acquire(paths, os.Getpid(), func(int) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Release(); err != nil {
		t.Fatal(err)
	}
}

func BenchmarkAcquireRelease(b *testing.B) {
	paths, err := Prepare(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		held, err := Acquire(paths, os.Getpid(), func(int) bool { return false })
		if err != nil {
			b.Fatal(err)
		}
		if err := held.Release(); err != nil {
			b.Fatal(err)
		}
	}
}
