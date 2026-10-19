// SPDX-License-Identifier: Apache-2.0
//go:build linux

package statedir

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func inspectProcess(pid int) (processIdentity, error) {
	root := fmt.Sprintf("/proc/%d/", pid)
	before, err := linuxStartTicks(root + "stat")
	if err != nil {
		return processIdentity{}, err
	}
	executable, err := os.Readlink(root + "exe")
	if err != nil {
		return processIdentity{}, processLookupError(err)
	}
	after, err := linuxStartTicks(root + "stat")
	if err != nil {
		return processIdentity{}, err
	}
	if before != after {
		return processIdentity{}, errors.New("process changed during identity check")
	}
	// AT_CLKTCK supplies the kernel's USER_HZ; do not assume a tick rate.
	auxv, err := os.ReadFile("/proc/self/auxv")
	if err != nil {
		return processIdentity{}, err
	}
	wordBytes := strconv.IntSize / 8
	word := func(data []byte) uint64 {
		if wordBytes == 8 {
			return binary.NativeEndian.Uint64(data)
		}
		return uint64(binary.NativeEndian.Uint32(data))
	}
	var ticksPerSecond uint64
	for offset := 0; offset+2*wordBytes <= len(auxv); offset += 2 * wordBytes {
		if word(auxv[offset:]) == 17 { // AT_CLKTCK
			ticksPerSecond = word(auxv[offset+wordBytes:])
			break
		}
	}
	if ticksPerSecond == 0 {
		return processIdentity{}, errors.New("missing process clock frequency")
	}
	stat, err := os.ReadFile("/proc/stat")
	if err != nil {
		return processIdentity{}, err
	}
	for _, line := range strings.Split(string(stat), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != "btime" {
			continue
		}
		boot, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return processIdentity{}, err
		}
		started := time.Unix(boot+int64(after/ticksPerSecond), int64(after%ticksPerSecond)*int64(time.Second)/int64(ticksPerSecond))
		return processIdentity{Executable: executable, Started: started}, nil
	}
	return processIdentity{}, errors.New("missing process boot time")
}

func linuxStartTicks(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, processLookupError(err)
	}
	// The parenthesized comm field can itself contain spaces and parentheses.
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return 0, errors.New("invalid process stat")
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) <= 19 {
		return 0, errors.New("missing process start time")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}
