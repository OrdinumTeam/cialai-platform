//go:build windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

func LockInstallation(root string) (func(), error) {
	if e := privateDirectory(root); e != nil {
		return nil, e
	}
	path := filepath.Join(root, ".update.lock")
	if stat, e := os.Lstat(path); e == nil && !stat.Mode().IsRegular() {
		return nil, errors.New("unsafe update lock")
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	overlapped := new(windows.Overlapped)
	if e = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped); e != nil {
		f.Close()
		return nil, errors.New("another Broto installation or update is running")
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, overlapped); f.Close() }, nil
}
