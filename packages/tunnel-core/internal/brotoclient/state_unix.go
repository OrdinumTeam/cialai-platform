//go:build !windows

package brotoclient

// statedir enforces the Unix owner permission bits before any private writes.
func protectState(root string) error { return nil }
