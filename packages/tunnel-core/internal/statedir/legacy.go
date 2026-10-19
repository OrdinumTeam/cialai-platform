// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type processIdentity struct {
	Executable string
	Started    time.Time
}

// Old sidecars wrote only a PID and nonce. Preserve their ownership during an
// upgrade only when the PID still names this tunnel executable and its start
// predates the record. A recycled PID or an unrelated executable is not an
// owner. Once a record uses OS locks, its PID can never prevent recovery.
func checkLegacyOwner(path, executable string, alive func(int) bool, inspect func(int) (processIdentity, error)) error {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read previous state owner: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("previous state owner must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return err
	}
	if len(data) > 4096 {
		return nil
	}
	var record lockRecord
	if json.Unmarshal(data, &record) == nil && record.Mechanism == "os-lock-v1" {
		return nil
	}
	pid, err := ParsePID(data)
	if err != nil || !alive(pid) {
		return nil
	}
	owner, err := inspect(pid)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("identify previous state owner: %w", err)
	}
	if sameTunnelExecutable(executable, owner.Executable) && !owner.Started.IsZero() && !owner.Started.After(info.ModTime()) {
		return fmt.Errorf("%w: legacy pid %d", ErrLocked, pid)
	}
	return nil
}

func sameTunnelExecutable(current, previous string) bool {
	// /proc/PID/exe keeps the original path after a running binary is updated.
	previous = strings.TrimSuffix(previous, " (deleted)")
	name := strings.TrimSuffix(filepath.Base(previous), ".exe")
	if name != "cialai-tunnel" && !strings.HasPrefix(name, "cialai-tunnel-") {
		return false
	}
	canonical := func(path string) string {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return resolved
		}
		return filepath.Clean(path)
	}
	current, previous = canonical(current), canonical(previous)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(current, previous)
	}
	return current == previous
}
