// SPDX-License-Identifier: Apache-2.0
//go:build windows

package identity

import "os"

// ownedByCaller is never consulted on Windows, where the key has no POSIX mode
// bits to repair; it exists so the package builds for every target.
func ownedByCaller(os.FileInfo) bool {
	return true
}
