// SPDX-License-Identifier: Apache-2.0

// Command directpath is the CON-010 connectivity spike. It deliberately stays
// outside the product packages: its job is to make real-network measurements
// reproducible before the production transport is designed around them.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var err error
	switch os.Args[1] {
	case "keygen":
		err = runKeygen(os.Args[2:])
	case "server":
		err = runServer(ctx, os.Args[2:])
	case "client":
		err = runClient(ctx, os.Args[2:])
	case "help", "-h", "--help":
		usage()
		return
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
			"event": "error",
			"error": err.Error(),
		})
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: directpath <command> [options]

commands:
  keygen  create or inspect a persistent Ed25519 identity
  server  listen with mutually pinned TLS 1.3 over QUIC
  client  read a server offer, connect and measure echo RTT

Run "directpath <command> -h" for command-specific options.`)
}
