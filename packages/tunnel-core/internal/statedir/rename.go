// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"os"
	"time"
)

const (
	// transientRetryWindow bounds how long Rename and ReadFile wait for other
	// handles on the file to close.
	transientRetryWindow = 2 * time.Second
	transientMaxBackoff  = 50 * time.Millisecond
)

// Rename replaces target with source like os.Rename. Windows refuses to
// replace a file while another handle has it open without FILE_SHARE_DELETE,
// which is how Go opens files, so a concurrent reader of the same state file
// makes the rename fail for a moment; Rename retries those errors with a short
// backoff. On other systems the rename is atomic and nothing is retried.
func Rename(source, target string) error {
	return retryTransient(func() error { return os.Rename(source, target) })
}

// ReadFile reads a state file like os.ReadFile. On Windows, opening a file
// while Rename replaces it fails with a sharing violation for a moment, so
// ReadFile retries the same transient errors as Rename.
func ReadFile(path string) ([]byte, error) {
	var data []byte
	err := retryTransient(func() error {
		var err error
		data, err = os.ReadFile(path)
		return err
	})
	return data, err
}

func retryTransient(operation func() error) error {
	delay := time.Millisecond
	deadline := time.Now().Add(transientRetryWindow)
	for {
		err := operation()
		if err == nil || !transientError(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(delay)
		delay = min(2*delay, transientMaxBackoff)
	}
}
