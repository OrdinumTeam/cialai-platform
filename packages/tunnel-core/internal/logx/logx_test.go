// SPDX-License-Identifier: Apache-2.0
package logx

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLoggerRedactsCredentialsAndSensitiveFieldNames(t *testing.T) {
	var output bytes.Buffer
	logger := New(&output, 10)
	logger.SetClock(func() time.Time { return time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC) })
	logger.Info("joining with tskey-auth-secret, cdt1.device.secret, CIALAI1.payload, CIALAI2.payload and token=visible", Fields{
		"apiKey": "hskey-api-prefix-secret",
		"nested": map[string]any{"deviceToken": "cdt1.device.secret", "safe": "kept"},
		"node":   "nodekey:abcdef",
	})
	line := strings.TrimSpace(output.String())
	for _, secret := range []string{"tskey-auth-secret", "visible", "hskey-api-prefix-secret", "cdt1.device.secret", "CIALAI1.payload", "CIALAI2.payload", "nodekey:abcdef"} {
		if strings.Contains(line, secret) {
			t.Fatalf("secret leaked: %s", secret)
		}
	}
	var entry Entry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Message == "" || entry.Fields["apiKey"] != Redacted {
		t.Fatalf("unexpected redacted entry: %#v", entry)
	}
	nested := entry.Fields["nested"].(map[string]any)
	if nested["deviceToken"] != Redacted || nested["safe"] != "kept" {
		t.Fatalf("unexpected nested fields: %#v", nested)
	}
}

func TestRotatingFileKeepsBoundedPrivateBackups(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tunnel.log")
	writer, err := NewRotatingFile(path, 24, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"first-log-line\n", "second-log-line\n", "third-log-line\n", "fourth-log-line\n"} {
		if _, err := writer.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{path, path + ".1", path + ".2"} {
		info, err := os.Stat(candidate)
		if err != nil {
			t.Fatalf("missing rotated log %s: %v", candidate, err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Fatalf("log %s mode is %o", candidate, info.Mode().Perm())
		}
	}
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Fatal("rotation exceeded configured backup count")
	}
}

func TestRotatingFileRefusesSymbolicLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links require privileges on some Windows hosts")
	}
	directory := t.TempDir()
	target := filepath.Join(directory, "target.log")
	if err := os.WriteFile(target, []byte("preserve\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "tunnel.log")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if writer, err := NewRotatingFile(link, 1024, 2); err == nil {
		_ = writer.Close()
		t.Fatal("accepted a symbolic link as the tunnel log")
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != "preserve\n" {
		t.Fatalf("log target changed: %q %v", contents, err)
	}
}

func TestRingIsBoundedAndReturnsIndependentTail(t *testing.T) {
	logger := New(&bytes.Buffer{}, 3)
	for index := 0; index < 5; index++ {
		logger.Info(string(rune('a'+index)), nil)
	}
	tail := logger.Tail(2)
	if len(tail) != 2 || tail[0].Message != "d" || tail[1].Message != "e" {
		t.Fatalf("unexpected tail: %#v", tail)
	}
	tail[0].Message = "changed"
	if logger.Tail(2)[0].Message != "d" {
		t.Fatal("tail aliases the logger ring")
	}
}

func TestDebugLevelIsExplicit(t *testing.T) {
	var output bytes.Buffer
	logger := New(&output, 10)
	logger.Debug("hidden", nil)
	if output.Len() != 0 {
		t.Fatal("debug was enabled by default")
	}
	if err := logger.SetLevel("debug"); err != nil {
		t.Fatal(err)
	}
	logger.Debug("shown", nil)
	if !strings.Contains(output.String(), `"message":"shown"`) {
		t.Fatalf("debug line missing: %s", output.String())
	}
	if err := logger.SetLevel("verbose"); err == nil {
		t.Fatal("accepted unknown log level")
	}
}
