// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package statedir

// transientError is always false: rename replaces open files atomically and
// readers never see the swap.
func transientError(error) bool { return false }
