//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"errors"
	"os"
	"syscall"
)

func privateDirectory(path string) error {
	if e := os.MkdirAll(path, 0700); e != nil {
		return e
	}
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() || !st.IsDir() || st.Mode()&0022 != 0 {
		return errors.New("unsafe releases directory")
	}
	return nil
}
