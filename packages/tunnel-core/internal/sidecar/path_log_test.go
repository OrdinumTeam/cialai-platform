// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"io"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
)

// TestPathEventsReachTheLog keeps in tunnel.log how each device reached the
// desktop, so a phone stuck on the Tor fallback can be diagnosed afterwards.
func TestPathEventsReachTheLog(t *testing.T) {
	options, _ := testOptions(t, "")
	r := newRuntime(options, rpc.NewWriter(io.Discard))
	defer r.close()

	r.emit("session.opened", map[string]string{"deviceId": "dev_1", "transport": "tor", "remoteAddr": "", "deviceKey": "not for the log"})
	r.emit("path.changed", map[string]any{"deviceId": "dev_1", "transport": "tor", "path": "tor", "address": "", "rttMs": int64(0), "reason": "punch refused"})
	r.emit("session.closed", map[string]string{"deviceId": "dev_1", "transport": "tor", "reason": "closed"})
	r.emit("devices.changed", map[string]any{"deviceId": "dev_1"})

	entries := options.Logger.Tail(100)
	if len(entries) != 3 {
		t.Fatalf("log has %d entries, want the three path events and nothing else: %+v", len(entries), entries)
	}
	opened, changed, closed := entries[0], entries[1], entries[2]
	if opened.Message != "session.opened" || opened.Fields["deviceId"] != "dev_1" || opened.Fields["transport"] != "tor" {
		t.Fatalf("opened = %+v", opened)
	}
	if _, kept := opened.Fields["deviceKey"]; kept {
		t.Fatal("the device key must stay out of the log")
	}
	if _, kept := opened.Fields["remoteAddr"]; kept {
		t.Fatal("an empty field must stay out of the log")
	}
	if changed.Message != "path.changed" || changed.Fields["reason"] != "punch refused" || changed.Fields["path"] != "tor" {
		t.Fatalf("changed = %+v", changed)
	}
	if _, kept := changed.Fields["rttMs"]; kept {
		t.Fatal("an unknown round trip must stay out of the log")
	}
	if closed.Message != "session.closed" || closed.Fields["reason"] != "closed" {
		t.Fatalf("closed = %+v", closed)
	}
}
