// SPDX-License-Identifier: Apache-2.0
//go:build windows

package statedir

import (
	"errors"
	"syscall"
)

// errorSharingViolation is ERROR_SHARING_VIOLATION, which syscall does not name.
const errorSharingViolation syscall.Errno = 32

// transientError reports the errors Windows returns while another handle
// holds a file open or a rename is replacing it.
func transientError(err error) bool {
	var errno syscall.Errno
	return errors.As(err, &errno) && (errno == syscall.ERROR_ACCESS_DENIED || errno == errorSharingViolation)
}
