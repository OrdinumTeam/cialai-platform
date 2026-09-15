// SPDX-License-Identifier: Apache-2.0
//go:build windows

package identity

import (
	"os"
	"syscall"
)

// publishNew gives the synced temporary file the name path unless path
// already exists, in which case the error matches os.ErrExist. MoveFile never
// replaces the target. A hard link is avoided here: Windows applies share
// modes per file, so removing the temporary name afterwards would conflict
// with a concurrent reader of the key, and that reader with the removal.
func publishNew(temporary, path string) error {
	from, err := syscall.UTF16PtrFromString(temporary)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	if err := syscall.MoveFile(from, to); err != nil {
		return &os.LinkError{Op: "move", Old: temporary, New: path, Err: err}
	}
	return nil
}
