//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package commandlauncher

import "os/exec"

func hideCommand(*exec.Cmd) {}
func launchDesktop(path string) error {
	command := exec.Command(path)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
