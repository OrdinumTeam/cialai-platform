// SPDX-License-Identifier: Apache-2.0
//go:build windows

package statedir

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func lockProcessFile(file *os.File) error {
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return ErrLocked
	}
	return err
}
