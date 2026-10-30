package brotocli

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoexec"
	"os"
	"path/filepath"
	"testing"
)

func TestFileRoundTripAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	remote := filepath.Join(dir, "remote")
	dest := filepath.Join(dir, "download")
	data := bytes.Repeat([]byte("cialai-integrity\x00"), 40000)
	if e := os.WriteFile(source, data, 0600); e != nil {
		t.Fatal(e)
	}
	ex := brotoexec.New(brotoexec.Config{AllowFiles: true, MaxFileMB: 2})
	defer ex.Close()
	call := func(ctx context.Context, m string, p json.RawMessage) (json.RawMessage, error) {
		var v struct {
			Cmd  string          `json:"cmd"`
			Args json.RawMessage `json:"args"`
		}
		json.Unmarshal(p, &v)
		result, e := ex.Handle(ctx, v.Cmd, v.Args)
		if e != nil {
			return nil, e
		}
		return encode(result), nil
	}
	if _, e := Upload(context.Background(), call, "d", source, remote, false, nil); e != nil {
		t.Fatal(e)
	}
	if _, e := Upload(context.Background(), call, "d", source, remote, false, nil); e == nil {
		t.Fatal("overwrote remote file")
	}
	if _, e := Download(context.Background(), call, "d", remote, dest, nil); e != nil {
		t.Fatal(e)
	}
	got, e := os.ReadFile(dest)
	if e != nil || !bytes.Equal(got, data) {
		t.Fatal("roundtrip differs", e)
	}
	if _, e := Download(context.Background(), call, "d", remote, dest, nil); e == nil {
		t.Fatal("overwrote local file")
	}
}
func TestCorruptDownloadNeverPublished(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "out")
	call := func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"type":"file","size":2,"sha256":"8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4","data":"aGk=","eof":true,"next_offset":2,"chunk_sha256":"bad"}`), nil
	}
	if _, e := Download(context.Background(), call, "d", "remote", dest, nil); e == nil {
		t.Fatal("corrupt block accepted")
	}
	if _, e := os.Stat(dest); !os.IsNotExist(e) {
		t.Fatal("partial was published")
	}
}

func TestLargeFileRoundTrip(t *testing.T) {
	if os.Getenv("CIALAI_BROTO_LARGE_FILE_TEST") != "1" {
		t.Skip("opt-in 100 MiB transfer; use SSD TMPDIR")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	remote := filepath.Join(dir, "remote")
	dest := filepath.Join(dir, "download")
	f, e := os.Create(source)
	if e != nil {
		t.Fatal(e)
	}
	block := bytes.Repeat([]byte("cialai-proof-100m"), 65536)[:1<<20]
	for i := 0; i < 100; i++ {
		if _, e = f.Write(block); e != nil {
			t.Fatal(e)
		}
	}
	f.Close()
	ex := brotoexec.New(brotoexec.Config{AllowFiles: true, MaxFileMB: 128})
	defer ex.Close()
	call := func(ctx context.Context, m string, p json.RawMessage) (json.RawMessage, error) {
		var v struct {
			Cmd  string          `json:"cmd"`
			Args json.RawMessage `json:"args"`
		}
		json.Unmarshal(p, &v)
		result, e := ex.Handle(ctx, v.Cmd, v.Args)
		if e != nil {
			return nil, e
		}
		return encode(result), nil
	}
	uploaded, e := Upload(context.Background(), call, "d", source, remote, false, nil)
	if e != nil {
		t.Fatal(e)
	}
	downloaded, e := Download(context.Background(), call, "d", remote, dest, nil)
	if e != nil {
		t.Fatal(e)
	}
	var up, down struct {
		SHA  string `json:"sha256"`
		Size int64  `json:"size"`
	}
	json.Unmarshal(uploaded, &up)
	json.Unmarshal(downloaded, &down)
	if up != down || up.Size != 100*1024*1024 {
		t.Fatalf("mismatch %+v %+v", up, down)
	}
	t.Logf("size=%d sha256=%s verified upload and download", up.Size, up.SHA)
}
