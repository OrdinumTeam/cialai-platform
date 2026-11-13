//go:build !windows

package brotoclient

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
)

func platformAddress(dir string) string { return filepath.Join(dir, "control.sock") }
func listenControl(address string) (net.Listener, error) {
	if err := socketDir(address); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(address); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("control path is not a socket")
		}
		conn, dialErr := net.Dial("unix", address)
		if dialErr == nil {
			_ = conn.Close()
			return nil, errors.New("control socket already active")
		}
		if err = os.Remove(address); err != nil {
			return nil, err
		}
	}
	listener, err := net.Listen("unix", address)
	if err == nil {
		err = os.Chmod(address, 0600)
		if err != nil {
			_ = listener.Close()
		}
	}
	return listener, err
}
func dialControl(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", address)
}
func prepareTor(cmd *exec.Cmd) {}
