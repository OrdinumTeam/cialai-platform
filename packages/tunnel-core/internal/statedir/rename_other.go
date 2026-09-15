// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package statedir

// transientRenameError is always false: rename replaces open files atomically.
func transientRenameError(error) bool { return false }
