// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/commandlauncher"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(120)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	os.Exit(commandlauncher.Run(ctx, executable, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
