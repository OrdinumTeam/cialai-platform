// SPDX-License-Identifier: Apache-2.0
//go:build windows

package statedir

import (
	"errors"
	"syscall"
)

// errorSharingViolation is ERROR_SHARING_VIOLATION, which syscall does not name.
const errorSharingViolation syscall.Errno = 32

// transientRenameError reports the errors MoveFileEx returns while another
// handle still holds the source or the target open.
func transientRenameError(err error) bool {
	var errno syscall.Errno
	return errors.As(err, &errno) && (errno == syscall.ERROR_ACCESS_DENIED || errno == errorSharingViolation)
}
