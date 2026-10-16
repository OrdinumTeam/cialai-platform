// SPDX-License-Identifier: Apache-2.0
//go:build darwin

package statedir

import (
	"bytes"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func inspectProcess(pid int) (processIdentity, error) {
	before, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return processIdentity{}, darwinProcessError(pid, err)
	}
	// KERN_PROCARGS2 begins with argc (int32), then the executable path. No
	// arguments or environment values are retained or logged.
	args, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return processIdentity{}, darwinProcessError(pid, err)
	}
	if len(args) < 5 {
		return processIdentity{}, errors.New("missing process executable")
	}
	end := bytes.IndexByte(args[4:], 0)
	if end <= 0 {
		return processIdentity{}, errors.New("invalid process executable")
	}
	after, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return processIdentity{}, darwinProcessError(pid, err)
	}
	if before.Proc.P_starttime != after.Proc.P_starttime || int(after.Proc.P_pid) != pid {
		return processIdentity{}, errors.New("process changed during identity check")
	}
	start := after.Proc.P_starttime
	return processIdentity{Executable: string(args[4 : 4+end]), Started: time.Unix(start.Sec, int64(start.Usec)*1000)}, nil
}

func darwinProcessError(pid int, err error) error {
	// Darwin reports an empty KERN_PROC result as EIO, including a process
	// that exited after the first liveness sample. Signal 0 only queries
	// existence; never reinterpret EIO or permission denial as dead alone.
	if errors.Is(err, unix.EIO) && errors.Is(unix.Kill(pid, 0), unix.ESRCH) {
		return os.ErrNotExist
	}
	return processLookupError(err)
}
