// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

type SupervisorConfig struct {
	Root, StateDir, STUNServers string
	// Shorter timings are only used by the isolated process tests.
	pollInterval, readyTimeout, stopTimeout time.Duration
}

// Supervise keeps SCM alive even when a candidate fails, so restoring the
// private pointer is sufficient to recover the previous verified release.
func Supervise(ctx context.Context, c SupervisorConfig) error {
	if e := privateDirectory(c.Root); e != nil {
		return e
	}
	poll := c.pollInterval
	if poll <= 0 {
		poll = 250 * time.Millisecond
	}
	readyTimeout := c.readyTimeout
	if readyTimeout <= 0 {
		readyTimeout = 90 * time.Second
	}
	stopTimeout := c.stopTimeout
	if stopTimeout <= 0 {
		stopTimeout = 5 * time.Second
	}
	pointer := filepath.Join(c.Root, "current-path")
	active := filepath.Join(c.Root, "active-path")
	read := func() (string, error) {
		raw, e := statedir.ReadFile(pointer)
		if e != nil {
			return "", e
		}
		binary := strings.TrimSpace(string(raw))
		relative, e := filepath.Rel(filepath.Join(c.Root, "releases"), binary)
		if e != nil || !filepath.IsAbs(binary) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || strings.ContainsAny(binary, "\r\n\x00") {
			return "", errors.New("unsafe supervised binary")
		}
		return binary, nil
	}
	retry := func() bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(poll):
			return true
		}
	}
	for ctx.Err() == nil {
		binary, e := read()
		if e != nil {
			return e
		}
		child := exec.Command(binary, "serve", "--state-dir", c.StateDir, "--stun", c.STUNServers)
		prepareSupervisedChild(child)
		child.Stdout = io.Discard
		child.Stderr = io.Discard
		child.WaitDelay = time.Second
		if e = child.Start(); e != nil {
			if !retry() {
				return nil
			}
			continue
		}
		done := make(chan error, 1)
		go func() { done <- child.Wait() }()
		ownHealth := binary + "\n" + strconv.Itoa(child.Process.Pid) + "\n"
		clearHealth := func() {
			raw, e := statedir.ReadFile(active)
			if e == nil && string(raw) == ownHealth {
				_ = atomicPointerWrite(active, nil)
			}
		}
		health := func(probe context.Context) bool {
			pid, e := probeServicePID(probe, binary, c.StateDir)
			return e == nil && pid == child.Process.Pid
		}
		stop := func() error {
			grace, cancel := context.WithTimeout(context.Background(), stopTimeout)
			defer cancel()
			if health(grace) {
				command := exec.CommandContext(grace, binary, "encerrar-servico", "--state-dir", c.StateDir)
				prepareSupervisedChild(command)
				command.WaitDelay = time.Second
				_ = command.Run()
			}
			select {
			case <-done:
				clearHealth()
				return nil
			case <-grace.Done():
			}
			// A graceful exit and the deadline may become ready together. Wait
			// owns the process handle, so do not kill an already reaped child.
			select {
			case <-done:
				clearHealth()
				return nil
			default:
			}
			killCtx, killCancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer killCancel()
			killErr := terminateSupervisedTree(killCtx, child)
			select {
			case <-done:
				clearHealth()
				// The child can exit while taskkill runs. A released Windows
				// handle then reports EINVAL; confirmed exit is already success.
				return nil
			case <-killCtx.Done():
				clearHealth()
				return errors.Join(killErr, errors.New("supervised child did not exit after termination"))
			}
		}
		started := time.Now()
		ready := false
		restart := false
		tick := time.NewTicker(poll)
		for !restart {
			select {
			case <-ctx.Done():
				tick.Stop()
				return stop()
			case <-done:
				clearHealth()
				restart = true
			case <-tick.C:
				if !ready && health(ctx) {
					if e = atomicPointerWrite(active, []byte(ownHealth)); e != nil {
						tick.Stop()
						_ = stop()
						return e
					}
					ready = true
				}
				if !ready && time.Since(started) > readyTimeout {
					if e = stop(); e != nil {
						tick.Stop()
						return e
					}
					restart = true
					continue
				}
				next, e := read()
				if e != nil {
					tick.Stop()
					_ = stop()
					return e
				}
				if next != binary {
					if e = stop(); e != nil {
						tick.Stop()
						return e
					}
					restart = true
				}
			}
		}
		tick.Stop()
		if !retry() {
			return nil
		}
	}
	return nil
}

func probeServicePID(ctx context.Context, binary, stateDir string) (int, error) {
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	command := exec.CommandContext(probe, binary, "status", "--state-dir", stateDir, "--pid-only")
	prepareSupervisedChild(command)
	command.WaitDelay = time.Second
	raw, e := command.Output()
	if e != nil {
		return 0, e
	}
	pid, e := strconv.Atoi(strings.TrimSpace(string(raw)))
	if e != nil || pid <= 0 {
		return 0, errors.New("service health did not identify a process")
	}
	return pid, nil
}
