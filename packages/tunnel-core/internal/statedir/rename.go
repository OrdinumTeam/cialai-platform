// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"os"
	"time"
)

const (
	// renameRetryWindow bounds how long Rename waits for other handles on
	// the target to close.
	renameRetryWindow = 2 * time.Second
	renameMaxBackoff  = 50 * time.Millisecond
)

// Rename replaces target with source like os.Rename. Windows refuses to
// replace a file while another handle has it open without FILE_SHARE_DELETE,
// which is how Go opens files, so a concurrent reader of the same state file
// makes the rename fail for a moment; Rename retries those errors with a short
// backoff. On other systems the rename is atomic and nothing is retried.
func Rename(source, target string) error {
	delay := time.Millisecond
	deadline := time.Now().Add(renameRetryWindow)
	for {
		err := os.Rename(source, target)
		if err == nil || !transientRenameError(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(delay)
		delay = min(2*delay, renameMaxBackoff)
	}
}
