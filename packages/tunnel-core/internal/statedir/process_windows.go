// SPDX-License-Identifier: Apache-2.0
//go:build windows

package statedir

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func inspectProcess(pid int) (processIdentity, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return processIdentity{}, os.ErrNotExist
	}
	if err != nil {
		return processIdentity{}, err
	}
	defer windows.CloseHandle(handle)
	path := make([]uint16, 32768)
	size := uint32(len(path))
	if err := windows.QueryFullProcessImageName(handle, 0, &path[0], &size); err != nil {
		return processIdentity{}, err
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return processIdentity{}, err
	}
	if exited.LowDateTime != 0 || exited.HighDateTime != 0 {
		return processIdentity{}, os.ErrNotExist
	}
	return processIdentity{Executable: windows.UTF16ToString(path[:size]), Started: time.Unix(0, created.Nanoseconds())}, nil
}
