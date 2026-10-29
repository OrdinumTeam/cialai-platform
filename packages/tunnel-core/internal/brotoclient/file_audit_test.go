package brotoclient

import (
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoexec"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileFailuresAuditedWithoutContents(t *testing.T) {
	dir := t.TempDir()
	c, err := New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	m := brotorpc.Message{Cmd: "files.put", Actor: "ai", Args: json.RawMessage(`{"path":"report.txt","data":"PRIVATE_SENTINEL","sha256":"PRIVATE_SENTINEL"}`)}
	c.auditFileResult(0, m, nil, &brotoexec.Error{Code: "file_hash_mismatch", Message: "Hash inválido."})
	raw, err := os.ReadFile(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatalf("failed transfer missing from audit: %v", err)
	}
	var entry map[string]any
	if json.Unmarshal(raw, &entry) != nil || entry["outcome"] != "error" || entry["code"] != "file_hash_mismatch" || entry["path"] != "report.txt" {
		t.Fatalf("failed transfer reason absent: %s", raw)
	}
	if strings.Contains(string(raw), "PRIVATE_SENTINEL") {
		t.Fatal("file content leaked into audit")
	}
}
