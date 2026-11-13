//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func Activate(ctx context.Context, result Result) error {
	if e := validatePointer(result); e != nil {
		return e
	}
	if supervised(result) {
		return activateSupervised(ctx, result)
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	return activateUnix(ctx, result, home)
}

// activateUnix accepts an isolated descriptor home for real service tests.
// Production always supplies the current user's unchanged home directory.
func activateUnix(ctx context.Context, result Result, home string) error {
	path := filepath.Join(home, ".config", "systemd", "user", "cialai-broto.service")
	old, new := result.PreviousBinary, result.NextBinary
	if runtime.GOOS == "darwin" {
		path = filepath.Join(home, "Library", "LaunchAgents", "br.com.ordinum.cialai.broto.plist")
		escape := func(v string) string {
			return strings.NewReplacer("&", "&amp;", "<", "&lt;", "\"", "&quot;").Replace(v)
		}
		old, new = escape(old), escape(new)
	} else if runtime.GOOS == "linux" {
		escape := func(v string) string { return strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%").Replace(v) }
		old, new = escape(old), escape(new)
	} else {
		return errors.New("unsupported service platform")
	}
	stat, e := os.Lstat(path)
	if e != nil {
		return e
	}
	owner, ok := stat.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() || !stat.Mode().IsRegular() || stat.Mode()&0022 != 0 {
		return errors.New("unsafe service descriptor")
	}
	previous, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	if strings.Count(string(previous), old) != 1 {
		return errors.New("service descriptor does not match running release")
	}
	next := strings.Replace(string(previous), old, new, 1)
	if _, e = os.Stat(result.NextBinary); e != nil {
		return e
	}
	run := func(ctx context.Context, args ...string) error {
		if e := exec.CommandContext(ctx, args[0], args[1:]...).Run(); e != nil {
			return fmt.Errorf("service %s failed: %w", args[0], e)
		}
		return nil
	}
	uid := strconv.Itoa(os.Getuid())
	stop := func(ctx context.Context) error {
		if runtime.GOOS == "darwin" {
			return run(ctx, "launchctl", "bootout", "gui/"+uid, path)
		}
		return run(ctx, "systemctl", "--user", "stop", "cialai-broto.service")
	}
	start := func(ctx context.Context) error {
		if runtime.GOOS == "darwin" {
			return run(ctx, "launchctl", "bootstrap", "gui/"+uid, path)
		}
		if e := run(ctx, "systemctl", "--user", "daemon-reload"); e != nil {
			return e
		}
		return run(ctx, "systemctl", "--user", "start", "cialai-broto.service")
	}
	write := func(data []byte) error {
		f, e := os.CreateTemp(filepath.Dir(path), ".broto-service-")
		if e != nil {
			return e
		}
		defer os.Remove(f.Name())
		if _, e = f.Write(data); e != nil {
			f.Close()
			return e
		}
		if e = f.Close(); e != nil {
			return e
		}
		return os.Rename(f.Name(), path)
	}
	return activateUnixTransition(ctx, result, previous, []byte(next), unixActivationOps{stop: stop, start: start, write: write, probe: probeServicePID})
}

type unixActivationOps struct {
	stop, start func(context.Context) error
	write       func([]byte) error
	probe       func(context.Context, string, string) (int, error)
}

func waitUnixHealth(ctx context.Context, result Result, binary string, previousPID int, probe func(context.Context, string, string) (int, error)) error {
	for {
		pid, e := probe(ctx, binary, result.StateDir)
		if e == nil && pid > 0 && pid != previousPID {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("service did not become healthy after restart")
		case <-time.After(50 * time.Millisecond):
		}
	}
}
func activateUnixTransition(ctx context.Context, result Result, previous, next []byte, ops unixActivationOps) error {
	before, cancelBefore := context.WithTimeout(ctx, 2*time.Second)
	oldPID, _ := ops.probe(before, result.PreviousBinary, result.StateDir)
	cancelBefore()
	if e := ops.stop(ctx); e != nil {
		return e
	}
	err := ops.write(next)
	if err == nil {
		err = ops.start(ctx)
	}
	if err == nil {
		health, cancel := context.WithTimeout(ctx, 45*time.Second)
		err = waitUnixHealth(health, result, result.NextBinary, oldPID, ops.probe)
		cancel()
	}
	if err == nil {
		err = commitPointer(result)
	}
	if err == nil {
		return nil
	}
	rollback, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	// Unload a failed candidate before restoring the previous service descriptor.
	_ = ops.stop(rollback)
	restoreErr := ops.write(previous)
	var restartErr, healthErr error
	if restoreErr == nil {
		restartErr = ops.start(rollback)
		if restartErr == nil {
			healthErr = waitUnixHealth(rollback, result, result.PreviousBinary, oldPID, ops.probe)
		}
	}
	return errors.Join(err, restoreErr, restartErr, healthErr)
}
