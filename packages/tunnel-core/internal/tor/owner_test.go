// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	ps "github.com/mitchellh/go-ps"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

const (
	// ownerEnv turns the test binary into the process that owns a real tor,
	// the role the sidecar plays. "desktop" runs StartDesktop and closes it
	// when stdin ends; "idle" only lends its pid to __OwningControllerProcess.
	ownerEnv    = "CIALAI_TOR_OWNER"
	ownerDirEnv = "CIALAI_TOR_OWNER_DIR"
	// ownerPoll is how often tor checks that __OwningControllerProcess is
	// alive.
	ownerPoll = 15 * time.Second
	// ownerSlack covers scheduling and the exit itself after tor notices.
	ownerSlack = 5 * time.Second
)

func runOwnerProcess(mode string) int {
	switch mode {
	case "idle":
		fmt.Println("ready")
		_, _ = io.Copy(io.Discard, os.Stdin)
		return 0
	case "desktop":
	default:
		return 2
	}
	paths, err := statedir.Prepare(os.Getenv(ownerDirEnv))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	desktop, err := StartDesktop(DesktopConfig{
		Executable:   os.Getenv(realTorEnv),
		Dir:          paths.Tor,
		OnionKeyPath: paths.OnionKey,
		Output:       os.Stderr,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	_, err = desktop.WaitState(ctx, func(state State) bool { return state.Registered != "" })
	cancel()
	if err != nil {
		_ = desktop.Close()
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("tor %d\n", desktop.currentPID())
	_, _ = io.Copy(io.Discard, os.Stdin)
	started := time.Now()
	err = desktop.Close()
	fmt.Printf("closed %s\n", time.Since(started).Round(time.Millisecond))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

type ownerProcess struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	lines   *bufio.Scanner
	log     *lockedBuffer
}

func startOwner(t *testing.T, mode, dir string) *ownerProcess {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^$")
	command.Env = append(os.Environ(), ownerEnv+"="+mode, ownerDirEnv+"="+dir, "GORACE=atexit_sleep_ms=0")
	log := &lockedBuffer{}
	command.Stderr = log
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
		if t.Failed() {
			t.Logf("owner %s log:\n%s", mode, log.tail(40))
		}
	})
	return &ownerProcess{command: command, stdin: stdin, lines: bufio.NewScanner(stdout), log: log}
}

func (owner *ownerProcess) line(t *testing.T, prefix string) string {
	t.Helper()
	if !owner.lines.Scan() {
		t.Fatalf("owner ended before %q: %v", prefix, owner.lines.Err())
	}
	value, ok := strings.CutPrefix(owner.lines.Text(), prefix)
	if !ok {
		t.Fatalf("owner wrote %q, want prefix %q", owner.lines.Text(), prefix)
	}
	return value
}

func (owner *ownerProcess) torPID(t *testing.T) int {
	t.Helper()
	pid, err := strconv.Atoi(owner.line(t, "tor "))
	if err != nil || pid <= 0 || pid == owner.command.Process.Pid {
		t.Fatalf("owner reported tor pid %d, %v", pid, err)
	}
	return pid
}

// waitGone polls until pid no longer exists and returns how long it took.
func waitGone(pid int, limit time.Duration) (time.Duration, bool) {
	started := time.Now()
	for {
		if found, err := ps.FindProcess(pid); err == nil && found == nil {
			return time.Since(started), true
		}
		if time.Since(started) > limit {
			return time.Since(started), false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestRealTorFollowsItsOwner covers the CON-041 criteria with the bundled tor
// running under a separate owner process, as under the sidecar: Close stops
// it, killing the owner stops it, and __OwningControllerProcess alone stops it
// within tor's poll interval.
func TestRealTorFollowsItsOwner(t *testing.T) {
	executable := os.Getenv(realTorEnv)
	if executable == "" || testing.Short() {
		t.Skip(realTorEnv + " is not set")
	}

	t.Run("shutdown", func(t *testing.T) {
		owner := startOwner(t, "desktop", t.TempDir())
		pid := owner.torPID(t)
		started := time.Now()
		if err := owner.stdin.Close(); err != nil {
			t.Fatal(err)
		}
		closed := owner.line(t, "closed ")
		if err := owner.command.Wait(); err != nil {
			t.Fatalf("owner exit: %v", err)
		}
		requireGone(t, "closed", pid)
		t.Logf("Close took %s; owner exited and tor %d was gone %s after stdin closed", closed, pid, time.Since(started).Round(time.Millisecond))
	})

	t.Run("owner killed", func(t *testing.T) {
		owner := startOwner(t, "desktop", t.TempDir())
		pid := owner.torPID(t)
		killed := time.Now()
		if err := owner.command.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		_ = owner.command.Wait()
		if _, gone := waitGone(pid, ownerPoll+ownerSlack); !gone {
			t.Fatalf("tor %d survived its killed owner for %s", pid, time.Since(killed).Round(time.Millisecond))
		}
		t.Logf("tor %d was gone %s after its owner was killed", pid, time.Since(killed).Round(time.Millisecond))
	})

	t.Run("owner pid only", func(t *testing.T) {
		idle := startOwner(t, "idle", "")
		idle.line(t, "ready")
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		log := &lockedBuffer{}
		running, err := launch(ctx, launchSpec{
			creator:    execCreator{path: executable, output: log},
			executable: executable,
			dir:        filepath.Join(t.TempDir(), "tor"),
			role:       roleService,
			ownerPID:   idle.command.Process.Pid,
		})
		if err != nil {
			t.Fatalf("launch tor: %v\n%s", err, log.tail(30))
		}
		pid := running.pid
		defer func() {
			_ = running.stop(defaultShutdownGrace)
			requireGone(t, "pid only", pid)
			if t.Failed() {
				t.Logf("tor log:\n%s", log.tail(30))
			}
		}()
		// This process keeps the TAKEOWNERSHIP connection open, so only the
		// pid check can stop tor.
		killed := time.Now()
		if err := idle.command.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		_ = idle.command.Wait()
		select {
		case <-running.exited:
			t.Logf("tor %d exited %s after the __OwningControllerProcess pid was killed", pid, time.Since(killed).Round(time.Millisecond))
		case <-time.After(ownerPoll + ownerSlack):
			t.Fatalf("tor %d ignored the dead __OwningControllerProcess for %s", pid, ownerPoll+ownerSlack)
		}
	})
}
