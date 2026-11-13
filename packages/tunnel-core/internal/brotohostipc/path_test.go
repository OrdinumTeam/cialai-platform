// SPDX-License-Identifier: Apache-2.0
package brotohostipc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWindowsStateCaseDoesNotSelectAnotherHost(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows path semantics")
	}
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", "")
	state := filepath.Join(privateDir(t), "not-created", "Host-State")
	a, err := PathForStateDir(state)
	if err != nil {
		t.Fatal(err)
	}
	b, err := PathForStateDir(strings.ToUpper(state))
	if err != nil || a != b {
		t.Fatalf("same Windows state selected different endpoints: %s %s %v", a, b, err)
	}
}

func TestTwoStatesReachTheirOwnHost(t *testing.T) {
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", "")
	root := privateDir(t)
	// Keep socket fixtures in this private home directory as well.
	if os.PathSeparator == '/' {
		t.Setenv("HOME", root)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	paths := make([]string, 2)
	for i, name := range []string{"installed", "test"} {
		path, err := PathForStateDir(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		paths[i] = path
		done, err := Start(ctx, path, func(context.Context, string, json.RawMessage) (any, error) { return name, nil })
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cancel(); <-done })
	}
	for i, want := range []string{`"installed"`, `"test"`} {
		raw, err := Call(ctx, paths[i], "broto.list", nil)
		if err != nil || string(raw) != want {
			t.Fatalf("wrong host: %s %v", raw, err)
		}
	}
}

// Socket fixtures live in a private home directory, never in shared temp.
func privateDir(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(home, ".bi-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestDefaultPathSeparatesHostStates(t *testing.T) {
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", "")
	dir := privateDir(t)
	t.Setenv("CIALAI_BROTO_HOST_STATE_DIR", filepath.Join(dir, "installed"))
	a, err := DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CIALAI_BROTO_HOST_STATE_DIR", filepath.Join(dir, "test"))
	b, err := DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("different host states selected the same socket")
	}
	if len([]byte(a)) >= 104 || len([]byte(b)) >= 104 {
		t.Fatal("socket exceeds macOS limit")
	}
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", filepath.Join(dir, "explicit.sock"))
	override, err := DefaultPath()
	if err != nil || override != filepath.Join(dir, "explicit.sock") {
		t.Fatal("explicit override lost")
	}
}

func TestExplicitOverrideDoesNotNeedConfigHome(t *testing.T) {
	// An explicit endpoint remains usable when service launch environments lack
	// the variables used by the platform's default config-directory lookup.
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", "explicit-endpoint")
	t.Setenv("CIALAI_BROTO_HOST_STATE_DIR", "")
	for _, key := range []string{"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"} {
		t.Setenv(key, "")
	}
	path, err := DefaultPath()
	if err != nil || path != "explicit-endpoint" {
		t.Fatalf("explicit override depends on platform config home: %q %v", path, err)
	}
}

func TestDefaultPathMatchesInstalledState(t *testing.T) {
	t.Setenv("CIALAI_BROTO_HOST_SOCKET", "")
	t.Setenv("CIALAI_BROTO_HOST_STATE_DIR", "")
	var base string
	var err error
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("LOCALAPPDATA")
	case "linux":
		base = filepath.Join(privateDir(t), "data")
		t.Setenv("XDG_DATA_HOME", base)
	default:
		base, err = os.UserConfigDir()
		if err != nil {
			t.Fatal(err)
		}
	}
	want, err := PathForStateDir(filepath.Join(base, "br.com.ordinum.cialai", "tunnel"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := DefaultPath()
	if err != nil || got != want {
		t.Fatalf("default MCP endpoint differs from installed host: %s %s %v", got, want, err)
	}
}
