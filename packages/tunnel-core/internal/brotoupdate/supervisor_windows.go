//go:build windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

func prepareSupervisedChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
func terminateSupervisedTree(ctx context.Context, child *exec.Cmd) error {
	command := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/PID", strconv.Itoa(child.Process.Pid), "/T", "/F")
	prepareSupervisedChild(command)
	if err := command.Run(); err == nil {
		return nil
	}
	err := child.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
