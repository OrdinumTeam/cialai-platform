// SPDX-License-Identifier: Apache-2.0
package commandlauncher

import (
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func hideCommand(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func launchDesktop(path string) error {
	// Preserve the previous command's single-running-desktop check.
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err == nil {
		defer windows.CloseHandle(snapshot)
		entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
		for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
			if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(path)) {
				return nil
			}
		}
	}
	command := exec.Command(path)
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
