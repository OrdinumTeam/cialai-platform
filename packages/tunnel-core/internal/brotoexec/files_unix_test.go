//go:build !windows

package brotoexec

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilesReportAccountPermissionDenied(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read the permission fixture")
	}
	e, dir := fileExecutor(t)
	path := filepath.Join(dir, "unreadable")
	if err := os.WriteFile(path, []byte("fixture"), 0000); err != nil {
		t.Fatal(err)
	}
	for _, verb := range []string{"files.stat", "files.get"} {
		raw, _ := json.Marshal(fileArgs{Path: path, Length: 1024})
		_, err := e.Handle(context.Background(), verb, raw)
		if !strings.HasPrefix(Diagnostic(err), "file_permission_denied:") {
			t.Fatalf("%s: %v", verb, err)
		}
	}
	locked := filepath.Join(dir, "readonly")
	if err := os.Mkdir(locked, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0700) })
	raw, _ := json.Marshal(fileArgs{Path: filepath.Join(locked, "upload"), Data: []byte("x"), Final: true, SHA256: digest([]byte("x"))})
	_, err := e.Handle(context.Background(), "files.put", raw)
	if !strings.HasPrefix(Diagnostic(err), "file_permission_denied:") {
		t.Fatal(err)
	}
}
