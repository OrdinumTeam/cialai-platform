// SPDX-License-Identifier: Apache-2.0
//go:build darwin || linux

package statedir

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func processLookupError(err error) error {
	if errors.Is(err, unix.ESRCH) || errors.Is(err, unix.ENOENT) {
		return os.ErrNotExist
	}
	return err
}
