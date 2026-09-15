// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package tor

import "os/exec"

func hideWindow(*exec.Cmd) {}
