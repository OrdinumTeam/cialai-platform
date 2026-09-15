// SPDX-License-Identifier: Apache-2.0
//go:build netlab

// Command netlab-node runs the programs of the NAT and fallback laboratory in
// tools/net-lab. The integration test builds it for linux and mounts it in the
// containers, where each role runs as its own process:
//
//	desktop  stands in for the desktop supervisor: fake PTY bridge, static
//	         site and the real cialai-tunnel serve-stdio as a child, with the
//	         stdio protocol passed through to the test
//	phone    a headless phone around the mobile package, driven by JSON lines
//	relay    the simulated Tor network: a SOCKS5 entry for phones and a
//	         rendezvous point that onion services reach outbound
//	tor      started as <dir>/tor by the sidecar: a Tor stand-in that speaks
//	         the control protocol subset of internal/tor and publishes the
//	         onion service at the relay
//
// Every role only talks to addresses of the laboratory networks.
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if filepath.Base(os.Args[0]) == "tor" {
		os.Exit(runTor(os.Args[1:]))
	}
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "uso: netlab-node <desktop|phone|relay|tor> [opções]")
		os.Exit(2)
	}
	role, args := os.Args[1], os.Args[2:]
	switch role {
	case "desktop":
		os.Exit(runDesktop(args))
	case "phone":
		os.Exit(runPhone(args))
	case "relay":
		os.Exit(runRelay(args))
	case "tor":
		os.Exit(runTor(args))
	default:
		fmt.Fprintln(os.Stderr, "papel desconhecido:", role)
		os.Exit(2)
	}
}
