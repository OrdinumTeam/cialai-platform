//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"context"
	"errors"
	ps "github.com/mitchellh/go-ps"
	"os"
	"os/exec"
	"syscall"
)

func prepareSupervisedChild(cmd *exec.Cmd) {}
func terminateSupervisedTree(ctx context.Context, cmd *exec.Cmd) error {
	processes, _ := ps.Processes()
	var kill func(int)
	kill = func(parent int) {
		for _, p := range processes {
			if p.PPid() == parent {
				kill(p.Pid())
				_ = syscall.Kill(p.Pid(), syscall.SIGKILL)
			}
		}
	}
	kill(cmd.Process.Pid)
	err := cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
