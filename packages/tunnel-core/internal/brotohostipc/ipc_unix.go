//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotohostipc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func platformPath(path string) string { return path }
func validateParent(path string, create bool) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("Broto IPC %q: absolute IPC path required", path)
	}
	if len([]byte(path)) >= 104 {
		return fmt.Errorf("Broto IPC %q: path exceeds 103 bytes", path)
	}
	dir := filepath.Dir(path)
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return fmt.Errorf("Broto IPC %q: prepare private parent: %w", path, err)
		}
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("Broto IPC %q: parent unavailable; open the intended Cialai instance and check IPC diagnostics: %w", path, err)
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Broto IPC %q: symbolic parent refused; use a real private directory owned by this user", path)
	}
	if !st.IsDir() || st.Mode()&0022 != 0 {
		return fmt.Errorf("Broto IPC %q: parent must be a real directory and must not be writable by other users; use mode 0700", path)
	}
	if stat, ok := st.Sys().(*syscall.Stat_t); !ok || int(stat.Uid) != os.Getuid() {
		return fmt.Errorf("Broto IPC %q: IPC parent owner mismatch", path)
	}
	return nil
}
func listen(path string) (net.Listener, error) {
	if err := validateParent(path, true); err != nil {
		return nil, err
	}
	// Never unlink a socket a running host still answers. One that nobody
	// answers is left over from a host that crashed or was killed, and would
	// keep the AI away from the Brotos until someone deleted it by hand.
	l, e := net.Listen("unix", path)
	if e != nil && errors.Is(e, syscall.EADDRINUSE) && abandoned(path) {
		if os.Remove(path) == nil {
			l, e = net.Listen("unix", path)
		}
	}
	if e != nil {
		return nil, e
	}
	if e = os.Chmod(path, 0600); e != nil {
		l.Close()
		return nil, e
	}
	return l, nil
}

// abandoned reports a socket of this user that refuses connections.
func abandoned(path string) bool {
	st, e := os.Lstat(path)
	if e != nil || st.Mode()&os.ModeSocket == 0 {
		return false
	}
	if stat, ok := st.Sys().(*syscall.Stat_t); !ok || int(stat.Uid) != os.Getuid() {
		return false
	}
	conn, e := net.DialTimeout("unix", path, 500*time.Millisecond)
	if e == nil {
		conn.Close()
		return false
	}
	return errors.Is(e, syscall.ECONNREFUSED)
}
func dial(ctx context.Context, path string) (net.Conn, error) {
	if err := validateParent(path, false); err != nil {
		return nil, err
	}
	st, e := os.Lstat(path)
	if e != nil {
		return nil, fmt.Errorf("Broto IPC %q: endpoint unavailable; open the intended Cialai instance, check CIALAI_BROTO_HOST_STATE_DIR or CIALAI_BROTO_HOST_SOCKET and IPC diagnostics: %w", path, e)
	}
	if st.Mode()&os.ModeSocket == 0 || st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("unsafe IPC socket permissions")
	}
	stat, ok := st.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return nil, errors.New("IPC socket owner mismatch")
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
