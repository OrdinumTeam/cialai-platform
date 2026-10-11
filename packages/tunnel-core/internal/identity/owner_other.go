// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package identity

import (
	"os"
	"syscall"
)

// ownedByCaller reports whether info describes a file owned by the effective
// user of this process, the only owner whose mode bits readKey may repair.
func ownedByCaller(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Geteuid()
}
