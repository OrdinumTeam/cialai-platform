// SPDX-License-Identifier: Apache-2.0
//go:build windows

package tor

import (
	"os/exec"
	"syscall"
)

// createNoWindow keeps tor.exe, a console program, from opening a console
// window when the sidecar runs without one.
const createNoWindow = 0x08000000

func hideWindow(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
