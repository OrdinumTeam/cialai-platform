// SPDX-License-Identifier: Apache-2.0
//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package statedir

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func lockProcessFile(file *os.File) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return ErrLocked
		}
		return err
	}
}
