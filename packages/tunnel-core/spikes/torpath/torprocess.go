// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/cretz/bine/process"
	"github.com/cretz/bine/tor"
)

type processTracker struct {
	executable string
	stderr     io.Writer
	stdout     io.Writer

	mu   sync.Mutex
	done chan struct{}
	pid  int
}

type trackedProcess struct {
	command *exec.Cmd
	owner   *processTracker
}

func newProcessTracker(executable string, verbose bool) *processTracker {
	writer := io.Writer(io.Discard)
	if verbose {
		writer = os.Stderr
	}
	return &processTracker{
		executable: executable,
		stderr:     os.Stderr,
		stdout:     writer,
		done:       make(chan struct{}),
	}
}

func (tracker *processTracker) New(ctx context.Context, args ...string) (process.Process, error) {
	command := exec.CommandContext(ctx, tracker.executable, args...)
	command.Stdout = tracker.stdout
	command.Stderr = tracker.stderr
	return &trackedProcess{command: command, owner: tracker}, nil
}

func (process *trackedProcess) Start() error {
	if err := process.command.Start(); err != nil {
		return err
	}
	process.owner.mu.Lock()
	process.owner.pid = process.command.Process.Pid
	process.owner.mu.Unlock()
	return nil
}

func (process *trackedProcess) Wait() error {
	err := process.command.Wait()
	process.owner.mu.Lock()
	close(process.owner.done)
	process.owner.mu.Unlock()
	return err
}

func (*trackedProcess) EmbeddedControlConn() (net.Conn, error) {
	return nil, process.ErrControlConnUnsupported
}

func (tracker *processTracker) processID() int {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	return tracker.pid
}

type torRuntime struct {
	cancel   context.CancelFunc
	instance *tor.Tor
	tracker  *processTracker
}

func launchTor(executable string, files torFiles, server, verbose bool) (*torRuntime, time.Duration, error) {
	processContext, cancel := context.WithCancel(context.Background())
	tracker := newProcessTracker(executable, verbose)
	started := time.Now()
	instance, err := tor.Start(processContext, &tor.StartConf{
		DataDir:         files.dataDir,
		EnableNetwork:   false,
		NoAutoSocksPort: server,
		NoHush:          verbose,
		ProcessCreator:  tracker,
		TorrcFile:       files.torrc,
		DebugWriter: func() io.Writer {
			if verbose {
				return os.Stderr
			}
			return nil
		}(),
	})
	if err != nil {
		cancel()
		if tracker.processID() != 0 {
			select {
			case <-tracker.done:
			case <-time.After(5 * time.Second):
			}
		}
		return nil, 0, fmt.Errorf("start Tor: %w", err)
	}
	return &torRuntime{cancel: cancel, instance: instance, tracker: tracker}, time.Since(started), nil
}

func (runtime *torRuntime) close() error {
	if runtime == nil {
		return nil
	}
	closeErr := runtime.instance.Close()
	runtime.cancel()
	select {
	case <-runtime.tracker.done:
	case <-time.After(5 * time.Second):
		return errors.Join(closeErr, errors.New("Tor process did not exit within 5 seconds after cancellation"))
	}
	return closeErr
}

func (runtime *torRuntime) pid() int {
	if runtime == nil {
		return 0
	}
	return runtime.tracker.processID()
}
