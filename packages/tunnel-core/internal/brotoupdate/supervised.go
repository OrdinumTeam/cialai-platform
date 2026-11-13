// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"context"
	"errors"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func supervised(result Result) bool {
	if result.CurrentPointer == "" {
		return false
	}
	for _, name := range []string{"headless-mode", "supervised-mode"} {
		raw, e := statedir.ReadFile(filepath.Join(filepath.Dir(result.CurrentPointer), name))
		if e == nil && string(raw) == "1\n" {
			return true
		}
	}
	return false
}
func waitSupervisedHealth(ctx context.Context, active, binary, previous, stateDir string, allowExisting bool) error {
	for {
		raw, e := statedir.ReadFile(active)
		fields := strings.Split(strings.TrimSpace(string(raw)), "\n")
		if e == nil && len(fields) > 0 && fields[0] == binary {
			if string(raw) != previous {
				return nil
			}
			if allowExisting && len(fields) > 1 {
				expected, parseErr := strconv.Atoi(fields[1])
				actual, probeErr := probeServicePID(ctx, binary, stateDir)
				if parseErr == nil && probeErr == nil && expected > 0 && actual == expected {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}
func activateSupervised(ctx context.Context, result Result) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	active := filepath.Join(filepath.Dir(result.CurrentPointer), "active-path")
	previousHealth, _ := statedir.ReadFile(active)
	if e := commitPointer(result); e != nil {
		return e
	}
	wait, cancel := context.WithTimeout(ctx, 45*time.Second)
	err := waitSupervisedHealth(wait, active, result.NextBinary, string(previousHealth), result.StateDir, false)
	cancel()
	if err == nil {
		return nil
	}
	failedHealth, _ := statedir.ReadFile(active)
	rollback := result
	rollback.NextBinary = result.PreviousBinary
	if restoreErr := commitPointer(rollback); restoreErr != nil {
		return errors.Join(errors.New("service did not confirm the new version"), restoreErr)
	}
	recoverCtx, recoverCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer recoverCancel()
	recoveryErr := waitSupervisedHealth(recoverCtx, active, result.PreviousBinary, string(failedHealth), result.StateDir, true)
	return errors.Join(errors.New("service did not confirm the new version"), recoveryErr)
}
