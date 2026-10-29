//go:build windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"context"
	"errors"
	"golang.org/x/sys/windows/registry"
	"os/exec"
	"strings"
	"time"
)

func Activate(ctx context.Context, result Result) error {
	if e := validatePointer(result); e != nil {
		return e
	}
	if supervised(result) {
		return activateSupervised(ctx, result)
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\CialaiBroto`, registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	image, _, err := key.GetStringValue("ImagePath")
	if err != nil {
		return err
	}
	imagePath := func(binary string) string {
		value := "\"" + binary + "\" service"
		if result.StateDir != "" {
			value += " --state-dir \"" + result.StateDir + "\""
		}
		return value
	}
	if strings.TrimSpace(image) != imagePath(result.PreviousBinary) {
		return errors.New("SCM service does not match current release")
	}

	run := func(ctx context.Context, args ...string) error {
		return exec.CommandContext(ctx, args[0], args[1:]...).Run()
	}
	stop := func(ctx context.Context) error {
		return run(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Stop-Service -Name CialaiBroto -ErrorAction Stop; (Get-Service CialaiBroto).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))")
	}
	start := func(ctx context.Context) error {
		return run(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Service -Name CialaiBroto -ErrorAction Stop; (Get-Service CialaiBroto).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))")
	}
	configure := func(ctx context.Context, path string) error {
		return run(ctx, "sc.exe", "config", "CialaiBroto", "binPath=", imagePath(path))
	}
	if e := stop(ctx); e != nil {
		return e
	}
	e := configure(ctx, result.NextBinary)
	if e == nil {
		e = start(ctx)
	}
	if e == nil {
		e = commitPointer(result)
	}
	if e == nil {
		return nil
	}
	rollback, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return errors.Join(e, configure(rollback, result.PreviousBinary), start(rollback))
}
