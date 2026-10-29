//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotoinstall

import (
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
	"os"
	"os/exec"
	"strconv"
)

func platformUID() string           { return strconv.Itoa(os.Getuid()) }
func platformOwner() string         { return "" }
func privateRoot(path string) error { return brotoupdate.ProtectDirectory(path) }

func platformPowerShell() (string, error) { return "powershell.exe", nil }

func hideConsole(*exec.Cmd) {}
