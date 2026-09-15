// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package identity

import "os"

// publishNew gives the synced temporary file the name path unless path
// already exists, in which case the error matches os.ErrExist. A hard link
// never replaces the target, unlike rename.
func publishNew(temporary, path string) error {
	return os.Link(temporary, path)
}
