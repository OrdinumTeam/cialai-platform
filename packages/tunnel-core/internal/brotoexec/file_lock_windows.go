//go:build windows

package brotoexec

import (
	"golang.org/x/sys/windows"
	"os"
)

func lockTransfer(f *os.File) (func(), error) {
	o := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, o); err != nil {
		return nil, err
	}
	return func() { _ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, o) }, nil
}
