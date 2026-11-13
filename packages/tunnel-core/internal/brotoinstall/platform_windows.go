//go:build windows

// SPDX-License-Identifier: Apache-2.0
package brotoinstall

import (
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoaccount"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func platformUID() string { return "" }
func platformOwner() string {
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return ""
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return ""
	}
	return user.User.Sid.String()
}
func privateRoot(path string) error { return brotoupdate.ProtectDirectory(path) }

// The service runs as LocalSystem. A state kept by an earlier Broto may
// still allow only the owner, and only the owner can open it to LocalSystem.
func shareState(path string) error {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	}
	return brotoaccount.ProtectState(path)
}

func platformPowerShell() (string, error) {
	root, err := windows.GetSystemDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "WindowsPowerShell", "v1.0", "powershell.exe"), nil
}

// A janela do Broto chama o instalador sem console. Sem esta marca, cada
// PowerShell abria uma janela preta vazia por cima dela durante a instalação.
func hideConsole(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
