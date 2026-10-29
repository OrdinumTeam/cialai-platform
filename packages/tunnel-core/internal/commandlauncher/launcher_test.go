// SPDX-License-Identifier: Apache-2.0
package commandlauncher

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("CIALAI_LAUNCHER_TEST_RECORDER") == "1" {
		_ = json.NewEncoder(os.Stdout).Encode(os.Args[1:])
		os.Exit(17)
	}
	os.Exit(m.Run())
}

func TestNativeLauncherPreservesArgumentsAndExit(t *testing.T) {
	t.Setenv("CIALAI_LAUNCHER_TEST_RECORDER", "1")
	dir := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(Config{Marker: Marker, Launcher: self, Sidecar: self})
	if err := os.WriteFile(filepath.Join(dir, "cialai-command.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"broto", "rodar", "Windows de teste", "ação 漢字 🙂", `a"b`, "a&b", "a|b", "a^b", "a%b", "a!b", "", `C:\path with spaces\`}
	var out, stderr bytes.Buffer
	code := Run(context.Background(), filepath.Join(dir, "cialai.exe"), args, nil, &out, &stderr)
	if code != 17 {
		t.Fatalf("exit=%d stderr=%s", code, &stderr)
	}
	var received []string
	if err := json.Unmarshal(out.Bytes(), &received); err != nil || !reflect.DeepEqual(args, received) {
		t.Fatalf("argv changed: %q %v", received, err)
	}
}

func TestNativeLauncherRejectsForeignOrRelativeConfiguration(t *testing.T) {
	dir := t.TempDir()
	for _, contents := range []string{
		`{}`, `{"marker":"other","launcher":"relative","sidecar":"relative"}`,
		`{"marker":"cialai-command-native-v3","launcher":"relative","sidecar":"relative"}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, "cialai-command.json"), []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if code := Run(context.Background(), filepath.Join(dir, "cialai.exe"), []string{"broto"}, nil, &output, &output); code != 120 {
			t.Fatal("unsafe config accepted", code)
		}
	}
}
