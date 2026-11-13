//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"errors"
	"golang.org/x/sys/unix"
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
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("another Broto installation or update is running")
	}
	return func() { unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}
