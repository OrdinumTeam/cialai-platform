// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func archive(t *testing.T, link bool) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	files := map[string]string{"release.json": `{"version":"broto-v1.1.0","target":"linux-x64","binary":"cialai-broto"}`, "cialai-broto": "fixture executable", "tor/tor/tor": "fixture tor"}
	for name, text := range files {
		if e := tw.WriteHeader(&tar.Header{Name: name, Mode: 0700, Size: int64(len(text)), Typeflag: tar.TypeReg}); e != nil {
			t.Fatal(e)
		}
		tw.Write([]byte(text))
	}
	if link {
		tw.WriteHeader(&tar.Header{Name: "escape", Linkname: "/outside", Typeflag: tar.TypeSymlink})
	}
	tw.Close()
	gz.Close()
	return b.Bytes()
}
func config(t *testing.T, payload []byte) (Config, *int) {
	t.Helper()
	root := t.TempDir()
	current := filepath.Join(root, "current")
	os.Mkdir(current, 0700)
	os.WriteFile(filepath.Join(current, "release.json"), []byte(`{"version":"broto-v1.0.0","target":"linux-x64","binary":"cialai-broto"}`), 0600)
	sum := sha256.Sum256(payload)
	meta, _ := json.Marshal(Metadata{Tag: "broto-v1.1.0", Assets: []Asset{{Name: "CialaiBroto_linux-x64.tar.gz", URL: "https://updates.example/broto.tar.gz", Bytes: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}}})
	requests := 0
	values := map[string][]byte{"/latest.json": meta, "/latest.json.minisig": []byte("fixture signature"), "/broto.tar.gz": payload}
	return Config{URL: "https://updates.example/latest.json", PublicKey: "independent-fixture-key", CurrentDir: current, ReleasesDir: filepath.Join(root, "releases"), Target: "linux-x64", Client: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.URL.Scheme != "https" {
			t.Fatal("HTTP request")
		}
		value, ok := values[r.URL.Path]
		if !ok {
			return nil, errors.New("unexpected URL")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(value)), Header: http.Header{}}, nil
	})}, Verify: func(ctx context.Context, file, sig, key string) error {
		if key != "independent-fixture-key" {
			t.Fatal("wrong key")
		}
		if _, e := os.ReadFile(sig); e != nil {
			t.Fatal(e)
		}
		return nil
	}, CheckBinary: func(context.Context, string) error { return nil }}, &requests
}
func TestStageSignedRelease(t *testing.T) {
	c, requests := config(t, archive(t, false))
	result, e := Stage(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	if *requests != 3 || !result.ActivationRequired {
		t.Fatalf("result %#v requests %d", result, *requests)
	}
	value, e := os.ReadFile(result.NextBinary)
	if e != nil || string(value) != "fixture executable" {
		t.Fatalf("payload: %s %v", value, e)
	}
	if _, e = os.Stat(filepath.Join(c.CurrentDir, "release.json")); e != nil {
		t.Fatal("current release altered")
	}
	retry, e := Stage(context.Background(), c)
	if e != nil || retry.NextBinary != result.NextBinary {
		t.Fatal("signed staged release cannot retry activation", e)
	}
	os.WriteFile(result.NextBinary, []byte("tampered"), 0700)
	if _, e = Stage(context.Background(), c); e == nil {
		t.Fatal("accepted modified staged release")
	}

}
func TestSignatureFailureStopsBeforeArchive(t *testing.T) {
	c, requests := config(t, archive(t, false))
	c.Verify = func(context.Context, string, string, string) error { return errors.New("bad signature") }
	if _, e := Stage(context.Background(), c); e == nil || e.Error() != "bad signature" {
		t.Fatal(e)
	}
	if *requests != 2 {
		t.Fatal("archive fetched before signature verification")
	}
}
func TestArchiveSymlinkRejected(t *testing.T) {
	c, _ := config(t, archive(t, true))
	if _, e := Stage(context.Background(), c); e == nil {
		t.Fatal("archive symlink accepted")
	}
}
func TestAssessmentFailureDoesNotInstall(t *testing.T) {
	c, _ := config(t, archive(t, false))
	c.CheckBinary = func(context.Context, string) error { return errors.New("codesign refused") }
	if _, e := Stage(context.Background(), c); e == nil {
		t.Fatal("unsigned executable accepted")
	}
	entries, e := os.ReadDir(c.ReleasesDir)
	if e != nil || len(entries) != 0 {
		t.Fatalf("staging not cleaned: %v %v", entries, e)
	}
}
func TestConfigurationFailsClosed(t *testing.T) {
	c, requests := config(t, archive(t, false))
	c.PublicKey = ""
	if _, e := Stage(context.Background(), c); e == nil {
		t.Fatal("missing key accepted")
	}
	if *requests != 0 {
		t.Fatal("download without trusted key")
	}
	c.PublicKey = "key"
	c.URL = "http://updates.example/latest.json"
	if _, e := Stage(context.Background(), c); e == nil {
		t.Fatal("HTTP accepted")
	}
}
func TestTamperedArchiveRejected(t *testing.T) {
	c, _ := config(t, archive(t, false))
	original := c.Client.Transport
	c.Client.Transport = transport(func(req *http.Request) (*http.Response, error) {
		response, e := original.RoundTrip(req)
		if e == nil && req.URL.Path == "/broto.tar.gz" {
			data, _ := io.ReadAll(response.Body)
			response.Body.Close()
			data[len(data)-1] ^= 1
			response.Body = io.NopCloser(bytes.NewReader(data))
		}
		return response, e
	})
	if _, e := Stage(context.Background(), c); e == nil || e.Error() != "update checksum mismatch" {
		t.Fatalf("expected checksum refusal, got %v", e)
	}
}
func TestTraversalRejected(t *testing.T) {
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "../outside", Mode: 0600, Size: 1, Typeflag: tar.TypeReg})
	tw.Write([]byte("x"))
	tw.Close()
	gz.Close()
	root := t.TempDir()
	path := filepath.Join(root, "payload.tar.gz")
	os.WriteFile(path, buffer.Bytes(), 0600)
	dest := filepath.Join(root, "dest")
	os.Mkdir(dest, 0700)
	if e := extract(path, dest); e == nil {
		t.Fatal("path traversal accepted")
	}
	if _, e := os.Stat(filepath.Join(root, "outside")); !os.IsNotExist(e) {
		t.Fatal("archive escaped destination")
	}
}

func TestRealMinisignStage(t *testing.T) {
	if _, e := exec.LookPath("minisign"); e != nil {
		t.Skip("minisign unavailable")
	}
	c, _ := config(t, archive(t, false))
	keys := t.TempDir()
	secret := filepath.Join(keys, "key")
	public := filepath.Join(keys, "pub")
	manifest := filepath.Join(keys, "latest.json")
	signature := manifest + ".minisig"
	if e := exec.Command("minisign", "-G", "-W", "-s", secret, "-p", public).Run(); e != nil {
		t.Fatal("ephemeral minisign key generation failed")
	}
	pub, e := os.ReadFile(public)
	if e != nil {
		t.Fatal(e)
	}
	lines := strings.Split(strings.TrimSpace(string(pub)), "\n")
	c.PublicKey = lines[len(lines)-1]
	c.Verify = nil
	original := c.Client.Transport
	c.Client.Transport = transport(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/latest.json.minisig" {
			value, e := os.ReadFile(signature)
			if e != nil {
				return nil, e
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(value)), Header: http.Header{}}, nil
		}
		resp, e := original.RoundTrip(req)
		if e != nil {
			return nil, e
		}
		if req.URL.Path == "/latest.json" {
			value, e := io.ReadAll(resp.Body)
			resp.Body.Close()
			if e != nil {
				return nil, e
			}
			if e = os.WriteFile(manifest, value, 0600); e != nil {
				return nil, e
			}
			if e = exec.Command("minisign", "-S", "-s", secret, "-m", manifest, "-x", signature).Run(); e != nil {
				return nil, errors.New("ephemeral manifest signing failed")
			}
			resp.Body = io.NopCloser(bytes.NewReader(value))
		}
		return resp, nil
	})
	if _, e = Stage(context.Background(), c); e != nil {
		t.Fatal(e)
	}
	// Reuse the real signature but alter the metadata body after signing.
	signed := c.Client.Transport
	c.Client.Transport = transport(func(req *http.Request) (*http.Response, error) {
		resp, e := signed.RoundTrip(req)
		if e == nil && req.URL.Path == "/latest.json" {
			value, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			value = bytes.Replace(value, []byte("broto-v1.1.0"), []byte("broto-v9.9.9"), 1)
			resp.Body = io.NopCloser(bytes.NewReader(value))
		}
		return resp, e
	})
	if _, e = Stage(context.Background(), c); e == nil || !strings.Contains(e.Error(), "signature verification failed") {
		t.Fatalf("tampered metadata accepted: %v", e)
	}
}
func TestInstallationLockAndRelease(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	unlock, e := LockInstallation(root)
	if e != nil {
		t.Fatal(e)
	}
	if second, e := LockInstallation(root); e == nil {
		second()
		t.Fatal("concurrent update accepted")
	}
	unlock()
	again, e := LockInstallation(root)
	if e != nil {
		t.Fatal("lock not released", e)
	}
	again()
}
func TestPointerMovesOnlyAfterValidatedVersion(t *testing.T) {
	root := filepath.Join(t.TempDir(), "install")
	if e := ProtectDirectory(root); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(root, "current-path")
	os.WriteFile(path, []byte("/old/cialai-broto\n"), 0600)
	result := Result{PreviousBinary: "/old/cialai-broto", NextBinary: "/new/cialai-broto", CurrentPointer: path}
	if e := validatePointer(result); e != nil {
		t.Fatal(e)
	}
	if e := commitPointer(result); e != nil {
		t.Fatal(e)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "/new/cialai-broto\n" {
		t.Fatal("pointer not advanced")
	}
	if e := validatePointer(result); e == nil {
		t.Fatal("old updater accepted stale active binary")
	}
}
func TestSupervisedActivationRequiresFreshHealthAcknowledgment(t *testing.T) {
	root := filepath.Join(t.TempDir(), "headless")
	if e := ProtectDirectory(root); e != nil {
		t.Fatal(e)
	}
	pointer := filepath.Join(root, "current-path")
	active := filepath.Join(root, "active-path")
	os.WriteFile(pointer, []byte("/old/bin\n"), 0600)
	os.WriteFile(filepath.Join(root, "headless-mode"), []byte("1\n"), 0600)
	result := Result{PreviousBinary: "/old/bin", NextBinary: "/new/bin", CurrentPointer: pointer}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			raw, _ := os.ReadFile(pointer)
			if strings.TrimSpace(string(raw)) == "/new/bin" {
				os.WriteFile(active, []byte("/new/bin\n"), 0600)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	if e := activateSupervised(ctx, result); e != nil {
		t.Fatal(e)
	}
	<-done
}

func TestPeriodicCheckAlreadyCurrentIsNotFailure(t *testing.T) {
	c, requests := config(t, archive(t, false))
	raw, _ := json.Marshal(Release{Version: "broto-v1.1.0", Target: "linux-x64", Binary: "cialai-broto"})
	os.WriteFile(filepath.Join(c.CurrentDir, "release.json"), raw, 0600)
	if _, e := Stage(context.Background(), c); !errors.Is(e, ErrNoUpdate) {
		t.Fatalf("already current: %v", e)
	}
	if *requests != 2 {
		t.Fatal("already current downloaded archive")
	}
}
func TestSupervisedActivationRejectsStaleAcknowledgment(t *testing.T) {
	root := filepath.Join(t.TempDir(), "headless")
	ProtectDirectory(root)
	pointer := filepath.Join(root, "current-path")
	os.WriteFile(pointer, []byte("/old/bin\n"), 0600)
	os.WriteFile(filepath.Join(root, "active-path"), []byte("/new/bin\n"), 0600)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	recovered := make(chan struct{})
	go func() {
		defer close(recovered)
		seenCandidate := false
		until := time.Now().Add(3 * time.Second)
		for time.Now().Before(until) {
			raw, _ := os.ReadFile(pointer)
			value := strings.TrimSpace(string(raw))
			if value == "/new/bin" {
				seenCandidate = true
			}
			if seenCandidate && value == "/old/bin" {
				_ = os.WriteFile(filepath.Join(root, "active-path"), []byte("/old/bin\nnew-ready\n"), 0600)
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	if e := activateSupervised(ctx, Result{PreviousBinary: "/old/bin", NextBinary: "/new/bin", CurrentPointer: pointer}); e == nil {
		t.Fatal("accepted a stale readiness record")
	}
	value, _ := os.ReadFile(pointer)
	if string(value) != "/old/bin\n" {
		t.Fatal("failed activation did not restore pointer")
	}
	<-recovered
}
