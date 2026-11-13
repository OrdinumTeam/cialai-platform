package brotoclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoexec"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

func TestExistingPolicyUsesAccountFileAccess(t *testing.T) {
	dir := t.TempDir()
	policyPath := filepath.Join(dir, "policy.json")
	policyJSON, _ := json.Marshal(map[string]any{"allowFiles": true, "fileRoots": []string{filepath.Join(dir, "project")}, "maxFileMB": 4})
	if err := os.WriteFile(policyPath, policyJSON, 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := loadPolicy(statedir.Paths{Root: dir})
	if err != nil || !policy.AllowFiles || policy.MaxFileMB != 4 {
		t.Fatalf("policy: %+v, %v", policy, err)
	}
	e := brotoexec.New(brotoexec.Config{AllowFiles: policy.AllowFiles, MaxFileMB: policy.MaxFileMB})
	defer e.Close()
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("account file"), 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"path": source})
	if _, err := e.Handle(t.Context(), "files.stat", raw); err != nil {
		t.Fatal(err)
	}
}
