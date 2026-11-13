// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestBrotoPollingLogLevel(t *testing.T) {
	options, _ := testOptions(t, "")
	r := newRuntime(options, rpc.NewWriter(io.Discard))
	defer r.close()
	for _, cmd := range []string{"pty.list", "pty.read", "files.list", "files.stat"} {
		r.brotos.Audit(brotorpc.Audit{Cmd: cmd, OK: true})
	}
	if len(options.Logger.Tail(100)) != 0 {
		t.Fatal("polling consumed info log")
	}
	for _, cmd := range []string{"exec", "pty.open", "pty.write"} {
		r.brotos.Audit(brotorpc.Audit{Cmd: cmd, OK: true})
	}
	if len(options.Logger.Tail(100)) != 3 {
		t.Fatal("real actions missing from info log")
	}
	options.Logger.SetLevel("debug")
	r.brotos.Audit(brotorpc.Audit{Cmd: "pty.list", OK: true})
	if options.Logger.Tail(1)[0].Level != "debug" {
		t.Fatal("polling missing at debug")
	}
}

func TestBrotoIPCStartupFailureInDiagnostics(t *testing.T) {
	// Relative paths are rejected before any socket or directory is created.
	path := filepath.Join("invalid-relative", "host.sock")
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", path)
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"diagnostics.run","args":{}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	options.EnableBrotoIPC = true
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve: %d", code)
	}
	for _, f := range decodeFrames(t, output) {
		if f["id"] != float64(2) {
			continue
		}
		raw, _ := json.Marshal(f["result"])
		var d Diagnostics
		json.Unmarshal(raw, &d)
		for _, c := range d.Checks {
			if c.ID == "broto_ipc" && !c.OK && strings.Contains(c.Detail, path) {
				return
			}
		}
	}
	t.Fatal("IPC configuration failure missing from diagnostics")
}
