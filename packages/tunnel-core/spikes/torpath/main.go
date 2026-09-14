// SPDX-License-Identifier: Apache-2.0

// Command torpath proves a persistent v3 onion service and mutually pinned
// TLS over either an embedded Tor Expert Bundle or an external SOCKS proxy.
package main

import (
	"errors"
	"fmt"
	"os"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "torpath:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return usageError()
	}
	switch args[0] {
	case "keygen":
		return runKeygen(args[1:])
	case "onion-keygen":
		return runOnionKeygen(args[1:])
	case "server":
		return runServer(args[1:])
	case "client":
		return runClient(args[1:])
	case "rendezvous-server":
		return runRendezvousServer(args[1:])
	case "rendezvous-client":
		return runRendezvousClient(args[1:])
	case "help", "-h", "--help":
		fmt.Fprint(os.Stdout, usage())
		return nil
	default:
		return usageError()
	}
}

func usageError() error {
	return errors.New("expected keygen, onion-keygen, server, client, rendezvous-server, or rendezvous-client; run torpath help")
}

func usage() string {
	return `Usage:
  torpath keygen --identity <path>
  torpath onion-keygen --key <path>
  torpath server --tor <path> --state <dir> --identity <path> --peer-key <base64url>
  torpath client (--tor <path> --state <dir> | --socks <host:port>) --onion <host:port> --identity <path> --peer-key <base64url>
  torpath rendezvous-server --tor <path> --state <dir> --identity <path> --peer-key <base64url>
  torpath rendezvous-client (--tor <path> --state <dir> | --socks <host:port>) --onion <host:port> --identity <path> --peer-key <base64url>
`
}
