// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVersionAndDoctor(t *testing.T) {
	var output, stderr bytes.Buffer
	stdio := streams{in: strings.NewReader(""), out: &output, err: &stderr}
	if code := run([]string{"version"}, stdio, func(int) bool { return true }); code != 0 || !strings.Contains(output.String(), "cialai-tunnel 0.1.0") || !strings.Contains(output.String(), "tailscale 1.102.0") {
		t.Fatalf("bad version: code %d output %q", code, output.String())
	}
	output.Reset()
	stateDir := filepath.Join(t.TempDir(), "state")
	if code := run([]string{"doctor", "--state-dir", stateDir}, stdio, func(int) bool { return true }); code != 0 {
		t.Fatalf("doctor failed: code %d stderr %q", code, stderr.String())
	}
	var result map[string]any
	if err := json.Unmarshal(output.Bytes(), &result); err != nil || result["ok"] != true {
		t.Fatalf("bad doctor result: %#v %v", result, err)
	}
}

func TestServeOwnsAndReleasesStateLock(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"shutdown","args":{}}`,
	}, "\n") + "\n"
	var output, stderr bytes.Buffer
	stdio := streams{in: strings.NewReader(input), out: &output, err: &stderr}
	if code := run([]string{"serve-stdio", "--state-dir", stateDir, "--parent-pid", "123"}, stdio, func(pid int) bool { return pid == 123 || pid == os.Getpid() }); code != 0 {
		t.Fatalf("serve failed: code %d stderr %q output %q", code, stderr.String(), output.String())
	}
	if _, err := os.Stat(filepath.Join(stateDir, "pid")); !os.IsNotExist(err) {
		t.Fatalf("state lock remained after shutdown: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "tunnel.log")); err != nil {
		t.Fatalf("tunnel log missing: %v", err)
	}
}

func TestServeRejectsSecretsAsCommandLineFlags(t *testing.T) {
	var output, stderr bytes.Buffer
	stdio := streams{in: strings.NewReader(""), out: &output, err: &stderr}
	code := run([]string{"serve-stdio", "--state-dir", t.TempDir(), "--parent-pid", "123", "--api-key", "secret"}, stdio, func(int) bool { return true })
	if code != 2 {
		t.Fatalf("secret command-line flag was accepted: %d", code)
	}
}
