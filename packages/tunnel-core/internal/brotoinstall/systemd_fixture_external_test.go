//go:build linux

package brotoinstall

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aead.dev/minisign"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoclient"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
)

// This gate is only enabled in the disposable QEMU guest. It never installs
// services on a developer's normal Linux account.
func TestDisposableSystemdUserActivation(t *testing.T) {
	if os.Getenv("CIALAI_BROTO_SYSTEMD_FIXTURE") != "YES" {
		t.Skip("requires the isolated systemd guest")
	}
	if _, e := os.Stat("/run/cialai-disposable-systemd-lab"); e != nil || os.Geteuid() != 1000 {
		t.Fatal("requires disposable VM and ordinary uid 1000")
	}
	binary := os.Getenv("CIALAI_BROTO_TEST_BINARY")
	rawBinary, e := os.ReadFile(binary)
	if e != nil {
		t.Fatal(e)
	}
	home, e := os.UserHomeDir()
	if e != nil {
		t.Fatal(e)
	}
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	if _, e = os.Stat(filepath.Join(unitDir, "cialai-broto.service")); !os.IsNotExist(e) {
		t.Fatal("fixture requires no pre-existing Broto user service")
	}
	lab, e := os.MkdirTemp(home, ".broto-systemd-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(lab)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	command := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, args[0], args[1:]...)
		out, e := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), e
	}
	must := func(args ...string) string {
		t.Helper()
		out, e := command(args...)
		if e != nil {
			t.Fatalf("%s failed: %v %s", args[0], e, out)
		}
		return out
	}
	t.Log("SYSTEMD_VERSION", must("systemctl", "--version"))
	public, secret, e := minisign.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	sign := func(data []byte) []byte {
		reader := minisign.NewReader(bytes.NewReader(data))
		_, _ = io.Copy(io.Discard, reader)
		return reader.Sign(secret)
	}
	type payload struct {
		dir                          string
		archive, manifest, signature []byte
		version                      string
	}
	makePayload := func(version string, executable []byte) payload {
		dir := filepath.Join(lab, "payload-"+version)
		if e := os.MkdirAll(dir, 0700); e != nil {
			t.Fatal(e)
		}
		meta, _ := json.Marshal(brotoupdate.Release{Version: version, Target: "linux-x64", Binary: "cialai-broto"})
		files := map[string][]byte{"cialai-broto": executable, "release.json": meta}
		var checks strings.Builder
		for _, name := range []string{"cialai-broto", "release.json"} {
			mode := os.FileMode(0600)
			if name == "cialai-broto" {
				mode = 0700
			}
			if e := os.WriteFile(filepath.Join(dir, name), files[name], mode); e != nil {
				t.Fatal(e)
			}
			fmt.Fprintf(&checks, "%x  %s\n", sha256.Sum256(files[name]), name)
		}
		files["SHA256SUMS.txt"] = []byte(checks.String())
		files["SHA256SUMS.txt.minisig"] = sign(files["SHA256SUMS.txt"])
		for _, name := range []string{"SHA256SUMS.txt", "SHA256SUMS.txt.minisig"} {
			if e := os.WriteFile(filepath.Join(dir, name), files[name], 0600); e != nil {
				t.Fatal(e)
			}
		}
		var packed bytes.Buffer
		gz := gzip.NewWriter(&packed)
		tw := tar.NewWriter(gz)
		for _, name := range []string{"cialai-broto", "release.json", "SHA256SUMS.txt", "SHA256SUMS.txt.minisig"} {
			mode := int64(0600)
			if name == "cialai-broto" {
				mode = 0700
			}
			if e := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(files[name])), Typeflag: tar.TypeReg}); e != nil {
				t.Fatal(e)
			}
			if _, e := tw.Write(files[name]); e != nil {
				t.Fatal(e)
			}
		}
		if e := tw.Close(); e != nil {
			t.Fatal(e)
		}
		if e := gz.Close(); e != nil {
			t.Fatal(e)
		}
		return payload{dir: dir, archive: packed.Bytes(), version: version}
	}
	catalog := []payload{makePayload("broto-v0.0.1", rawBinary), makePayload("broto-v0.0.2", rawBinary), makePayload("broto-v0.0.3", []byte("invalid signed executable\n"))}
	cert, e := tls.LoadX509KeyPair(filepath.Join(home, "lab", "server.crt"), filepath.Join(home, "lab", "server.key"))
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	source := "https://" + listener.Addr().String()
	for i := range catalog {
		sum := sha256.Sum256(catalog[i].archive)
		metadata, _ := json.Marshal(brotoupdate.Metadata{Tag: catalog[i].version, Assets: []brotoupdate.Asset{{Name: "CialaiBroto_linux-x64.tar.gz", URL: source + "/asset.tar.gz", Bytes: int64(len(catalog[i].archive)), SHA256: hex.EncodeToString(sum[:])}}})
		catalog[i].manifest = metadata
		catalog[i].signature = sign(metadata)
	}
	var selected atomic.Int32
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := catalog[selected.Load()]
		switch r.URL.Path {
		case "/latest.json":
			_, _ = w.Write(current.manifest)
		case "/latest.json.minisig":
			_, _ = w.Write(current.signature)
		case "/asset.tar.gz":
			_, _ = w.Write(current.archive)
		default:
			http.NotFound(w, r)
		}
	})}
	go server.Serve(tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}))
	defer server.Close()
	state := filepath.Join(lab, "state")
	root := filepath.Join(lab, "install")
	cleanup := func() {
		clean, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		for _, name := range []string{"cialai-broto-update.timer", "cialai-broto-update.service", "cialai-broto.service"} {
			_ = exec.CommandContext(clean, "systemctl", "--user", "stop", name).Run()
			_ = exec.CommandContext(clean, "systemctl", "--user", "reset-failed", name).Run()
			_ = exec.CommandContext(clean, "systemctl", "--user", "disable", name).Run()
		}
		for _, name := range []string{"cialai-broto-update.timer", "cialai-broto-update.service", "cialai-broto.service"} {
			_ = os.Remove(filepath.Join(unitDir, name))
		}
		_ = exec.CommandContext(clean, "systemctl", "--user", "daemon-reload").Run()
	}
	defer cleanup()
	result, e := Install(ctx, Config{Payload: catalog[0].dir, PublicKey: public.String(), RootDir: root, URL: source + "/latest.json", HomeDir: home, StateDir: state, Activate: true})
	if e != nil {
		t.Fatal("real systemd install failed", e)
	}
	must("systemctl", "--user", "stop", "cialai-broto-update.timer", "cialai-broto-update.service")
	must("systemd-analyze", "--user", "verify", filepath.Join(unitDir, "cialai-broto.service"), filepath.Join(unitDir, "cialai-broto-update.service"), filepath.Join(unitDir, "cialai-broto-update.timer"))
	health := func(expected string) (int, string) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			raw, e := brotoclient.ControlCall(ctx, state, "broto.status", nil)
			var status brotoclient.Status
			if e == nil && json.Unmarshal(raw, &status) == nil && status.PID > 0 {
				main, e := command("systemctl", "--user", "show", "cialai-broto.service", "--property=MainPID", "--value")
				actual, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", status.PID))
				stat, _ := os.ReadFile(fmt.Sprintf("/proc/%d/stat", status.PID))
				if e == nil && main == strconv.Itoa(status.PID) && actual == expected {
					fields := strings.Fields(string(stat)[strings.LastIndex(string(stat), ")")+1:])
					if len(fields) > 19 {
						return status.PID, fields[19]
					}
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("service did not become ready for expected version; %s", must("systemctl", "--user", "show", "cialai-broto.service", "--property=ActiveState,SubState,Result"))
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	initialPID, initialStart := health(result.Binary)
	t.Log("INITIAL_PID", initialPID)
	must("systemctl", "--user", "restart", "cialai-broto.service")
	restartedPID, restartedStart := health(result.Binary)
	if restartedPID == initialPID && restartedStart == initialStart {
		t.Fatal("restart did not create a new service instance")
	}
	t.Log("RESTART_PID", restartedPID)
	selected.Store(1)
	must("systemctl", "--user", "start", "cialai-broto-update.service")
	next := filepath.Join(root, "releases", catalog[1].version, "cialai-broto")
	updatedPID, _ := health(next)
	pointer, _ := os.ReadFile(filepath.Join(root, "current-path"))
	if strings.TrimSpace(string(pointer)) != next {
		t.Fatal("update job did not commit the verified version")
	}
	t.Log("SIGNED_UPDATE_PID", updatedPID)
	selected.Store(2)
	if _, e := command("systemctl", "--user", "start", "cialai-broto-update.service"); e == nil {
		t.Fatal("signed candidate with invalid executable was accepted")
	}
	restoredPID, _ := health(next)
	pointer, _ = os.ReadFile(filepath.Join(root, "current-path"))
	if strings.TrimSpace(string(pointer)) != next {
		t.Fatal("failed candidate changed the current pointer")
	}
	t.Log("ROLLBACK_HEALTHY_PID", restoredPID)
	t.Log("SYSTEMD_REAL_INSTALL_RESTART_UPDATE_ROLLBACK_PASS")
}
