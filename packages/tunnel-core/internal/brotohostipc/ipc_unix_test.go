//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package brotohostipc

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListenReplacesOnlyAnAbandonedSocket(t *testing.T) {
	// Unix socket paths have a short limit on macOS; the default temp dir is too long.
	dir := privateDir(t)
	path := filepath.Join(dir, "host.sock")
	crashed, err := listen(path)
	if err != nil {
		t.Fatal(err)
	}
	crashed.(*net.UnixListener).SetUnlinkOnClose(false)
	crashed.Close()
	live, err := listen(path)
	if err != nil {
		t.Fatalf("abandoned socket blocked a new host: %v", err)
	}
	defer live.Close()
	if second, err := listen(path); err == nil {
		second.Close()
		t.Fatal("a running host lost its socket")
	}
}

func TestUnsafeParentExplainedBeforeMissingSocket(t *testing.T) {
	root := privateDir(t)
	for _, kind := range []string{"symbolic", "group writable", "other writable"} {
		t.Run(kind, func(t *testing.T) {
			dir := filepath.Join(root, strings.ReplaceAll(kind, " ", "-"))
			if kind == "symbolic" {
				if err := os.Symlink(root, dir); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				mode := os.FileMode(0702)
				if kind == "group writable" {
					mode = 0720
				}
				if err := os.Chmod(dir, mode); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(dir, "absent.sock")
			_, err := dial(context.Background(), path)
			cause := "writable"
			if kind == "symbolic" {
				cause = kind
			}
			if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), cause) {
				t.Fatalf("client lacks cause and path: %v", err)
			}
			l, err := listen(path)
			if err == nil {
				l.Close()
				t.Fatal("unsafe parent accepted")
			}
			if !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), cause) {
				t.Fatalf("host lacks cause and path: %v", err)
			}
		})
	}
}

func TestMissingEndpointExplainsInstanceSelection(t *testing.T) {
	path := filepath.Join(privateDir(t), "missing.sock")
	_, err := Call(context.Background(), path, "broto.list", nil)
	for _, want := range []string{path, "CIALAI_BROTO_HOST_STATE_DIR", "IPC diagnostics"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("missing actionable endpoint diagnostic %q: %v", want, err)
		}
	}
}

func TestSocketPathLimitCountsBytes(t *testing.T) {
	root := privateDir(t)
	// The final component is long; no oversized socket is ever created.
	path := filepath.Join(root, strings.Repeat("é", 52))
	if len(path) < 104 {
		t.Fatal("fixture must exceed the macOS socket limit")
	}
	if _, err := listen(path); err == nil || !strings.Contains(err.Error(), "103 bytes") {
		t.Fatalf("host failed to explain byte limit: %v", err)
	}
	if _, err := dial(context.Background(), path); err == nil || !strings.Contains(err.Error(), "103 bytes") {
		t.Fatalf("client failed to explain byte limit: %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("oversized socket was created: %v", err)
	}
}
