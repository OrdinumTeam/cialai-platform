// SPDX-License-Identifier: Apache-2.0
package brotoinstall

import (
	"aead.dev/minisign"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func fixture(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	public, secret, e := minisign.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	binary := "cialai-broto"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	meta, _ := json.Marshal(brotoupdate.Release{Version: "broto-v1.0.0", Target: brotoupdate.HostTarget(), Binary: binary})
	files := map[string][]byte{binary: []byte("fixture executable"), "release.json": meta, "tor/tor/tor": []byte("fixture tor")}
	var manifest strings.Builder
	for name, data := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(path), 0700)
		os.WriteFile(path, data, 0700)
		fmt.Fprintf(&manifest, "%x  %s\n", sha256.Sum256(data), name)
	}
	value := []byte(manifest.String())
	os.WriteFile(filepath.Join(dir, "SHA256SUMS.txt"), value, 0600)
	reader := minisign.NewReader(bytes.NewReader(value))
	io.Copy(io.Discard, reader)
	os.WriteFile(filepath.Join(dir, "SHA256SUMS.txt.minisig"), reader.Sign(secret), 0600)
	return dir, public.String()
}
func TestIntegratedInstallPlanHasNoServiceSideEffects(t *testing.T) {
	source, key := fixture(t)
	root := filepath.Join(t.TempDir(), "install")
	home := t.TempDir()
	calls := 0
	result, e := Install(context.Background(), Config{Payload: source, PublicKey: key, RootDir: root, HomeDir: home, CheckBinary: func(context.Context, string) error { return nil }, Run: func(context.Context, Command) error { calls++; return nil }})
	if e != nil {
		t.Fatal(e)
	}
	if result.Activated || calls != 0 || len(result.Commands) == 0 {
		t.Fatal("prepare-only activated services")
	}
	if _, e = os.Stat(result.Binary); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(root, "current-path")); !os.IsNotExist(e) {
		t.Fatal("prepare-only installed scheduled configuration")
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Fatal("prepare-only changed service home")
	}
}
func TestIntegratedActivationUsesFakeRunnerAndIsRetryable(t *testing.T) {
	source, key := fixture(t)
	root := filepath.Join(t.TempDir(), "install")
	calls := 0
	c := Config{Payload: source, PublicKey: key, RootDir: root, HomeDir: t.TempDir(), Activate: true, CheckBinary: func(context.Context, string) error { return nil }, Run: func(context.Context, Command) error { calls++; return nil }}
	first, e := Install(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	if !first.Activated || calls != len(first.Commands) {
		t.Fatal("did not execute generated plan")
	}
	if _, e = Install(context.Background(), c); e != nil {
		t.Fatal("partial install cannot retry", e)
	}
}
func TestTamperedPayloadFailsBeforeInstall(t *testing.T) {
	source, key := fixture(t)
	os.WriteFile(filepath.Join(source, "release.json"), []byte(`{}`), 0600)
	root := filepath.Join(t.TempDir(), "install")
	if _, e := Install(context.Background(), Config{Payload: source, PublicKey: key, RootDir: root}); e == nil {
		t.Fatal("tampering accepted")
	}
	if _, e := os.Stat(root); !os.IsNotExist(e) {
		t.Fatal("untrusted payload changed installation")
	}
}
func TestPlansKeepUpdaterSeparateAndResolveCurrentVersion(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		files, commands, e := plan(platform, "/private/Broto Space", "/private/Broto Space/releases/broto-v1.0.0/cialai-broto", "trusted-public-key", DefaultURL, "/private/user", "S-1-5-21-1-2-3-1001")
		if e != nil {
			t.Fatal(e)
		}
		var all strings.Builder
		for _, file := range files {
			all.WriteString(file.Content)
		}
		if !strings.Contains(all.String(), "current-path") || !strings.Contains(all.String(), "atualizar") || !strings.Contains(all.String(), "current-pointer") || len(commands) == 0 {
			t.Fatal("missing periodic update wiring", platform)
		}
		if platform == "windows" && (!strings.Contains(all.String(), "Get-Credential") || !strings.Contains(all.String(), "Register-ScheduledTask") || !strings.Contains(all.String(), "SeServiceLogonRight")) {
			t.Fatal("Windows service setup missing")
		}
	}
}
func TestInstallerRejectsConfigurationInjection(t *testing.T) {
	if _, _, e := plan("linux", "/safe\nInjected", "/binary", "key", DefaultURL, "/home", ""); e == nil {
		t.Fatal("newline allowed")
	}
	if _, _, e := plan("linux", "/safe", "/binary", "key", "http://insecure", "/home", ""); e == nil {
		t.Fatal("HTTP allowed")
	}
}
func TestHeadlessMacUsesUnprivilegedBootJobsAndNoMutablePrivilegedInput(t *testing.T) {
	files, commands, e := plan("darwin", "/private/Broto Space", "/private/Broto Space/releases/v1/cialai-broto", "key", DefaultURL, "/Users/test", "", planOptions{Headless: true, User: "broto-test", Group: "staff"})
	if e != nil {
		t.Fatal(e)
	}
	var scripts strings.Builder
	marker := false
	for _, file := range files {
		scripts.WriteString(file.Content)
		if filepath.Base(file.Path) == "headless-mode" {
			marker = true
		}
	}
	if !strings.Contains(scripts.String(), "<key>UserName</key><string>broto-test</string>") || !marker {
		t.Fatal("headless boot lacks unprivileged identity")
	}
	if len(commands) != 1 || commands[0].Program != "/usr/bin/osascript" || !strings.Contains(commands[0].Args[1], "with administrator privileges") {
		t.Fatal("missing explicit admin consent")
	}
	if strings.Contains(commands[0].Args[1], " cp ") || strings.Contains(commands[0].Args[1], "headless-daemon.plist") {
		t.Fatal("root helper trusts a mutable user plist")
	}
	if _, _, e = headlessMac("/root", "/root", "root", "wheel"); e == nil {
		t.Fatal("headless service accepted root")
	}
}
func TestLinuxLingerIsExplicit(t *testing.T) {
	_, commands, e := plan("linux", "/private/broto", "/private/broto/binary", "key", DefaultURL, "/private/home", "")
	if e != nil {
		t.Fatal(e)
	}
	for _, cmd := range commands {
		if cmd.Program == "loginctl" {
			t.Fatal("default enables linger without explicit choice")
		}
	}
	_, commands, e = plan("linux", "/private/broto", "/private/broto/binary", "key", DefaultURL, "/private/home", "", planOptions{Linger: true})
	if e != nil {
		t.Fatal(e)
	}
	if commands[0].Program != "loginctl" {
		t.Fatal("explicit linger not configured")
	}
}
func TestHeadlessSupervisorRestartsActualCLI(t *testing.T) {
	executable := os.Getenv("CIALAI_BROTO_TEST_BINARY")
	if executable == "" || runtime.GOOS == "windows" {
		t.Skip("requires the locally built Unix CLI")
	}
	root, e := os.MkdirTemp("/tmp", "broto-supervisor-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	t.Setenv("CIALAI_BROTO_SOCKET", filepath.Join(root, "control.sock"))
	state := filepath.Join(root, "state")
	var versions []string
	for _, name := range []string{"version-a", "version-b"} {
		path := filepath.Join(root, name)
		script := "#!/bin/sh\nexec " + shell(executable) + " \"$@\" --stun ''\n"
		if e = os.WriteFile(path, []byte(script), 0700); e != nil {
			t.Fatal(e)
		}
		versions = append(versions, path)
	}
	files, _, e := headlessMac(root, root, "fixture-user", "staff", state)
	if e != nil {
		t.Fatal(e)
	}
	for _, file := range files {
		os.WriteFile(file.Path, []byte(file.Content), 0600)
	}
	pointer := filepath.Join(root, "current-path")
	os.WriteFile(pointer, []byte(versions[0]+"\n"), 0600)
	cmd := exec.Command("/bin/sh", filepath.Join(root, "run-service.sh"))
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	active := filepath.Join(root, "active-path")
	for {
		raw, _ := os.ReadFile(active)
		if strings.HasPrefix(string(raw), versions[0]+"\n") {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("first CLI did not become ready")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if e = brotoupdate.Activate(ctx, brotoupdate.Result{PreviousBinary: versions[0], NextBinary: versions[1], CurrentPointer: pointer}); e != nil {
		t.Fatal(e)
	}
	output, e := exec.Command(executable, "status", "--state-dir", state).Output()
	if e != nil || !bytes.Contains(output, []byte(`"state":"disconnected"`)) {
		t.Fatalf("restarted real CLI status failed: %v", e)
	}
}
func TestStableServiceSupervisorRestartsRealChildWithoutSCMChanges(t *testing.T) {
	executable := os.Getenv("CIALAI_BROTO_TEST_BINARY")
	if executable == "" {
		t.Skip("requires locally built CLI")
	}
	base := os.Getenv("CIALAI_BROTO_TEST_ROOT")
	if base == "" {
		base = os.TempDir()
	}
	root, e := os.MkdirTemp(base, "broto-supervisor-go-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	if runtime.GOOS == "windows" {
		t.Setenv("CIALAI_BROTO_SOCKET", `\\.\pipe\cialai-broto-fixture-`+filepath.Base(root))
	} else {
		socketRoot, err := os.MkdirTemp("", "brto-ipc-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(socketRoot) })
		t.Setenv("CIALAI_BROTO_SOCKET", filepath.Join(socketRoot, "control.sock"))
	}
	name := "cialai-broto"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	versions := []string{}
	for _, version := range []string{"v1", "v2"} {
		dir := filepath.Join(root, "releases", version)
		os.MkdirAll(dir, 0700)
		path := filepath.Join(dir, name)
		input, e := os.Open(executable)
		if e != nil {
			t.Fatal(e)
		}
		out, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if e != nil {
			t.Fatal(e)
		}
		_, e = io.Copy(out, input)
		input.Close()
		out.Close()
		if e != nil {
			t.Fatal(e)
		}
		versions = append(versions, path)
	}
	pointer := filepath.Join(root, "current-path")
	os.WriteFile(pointer, []byte(versions[0]+"\n"), 0600)
	os.WriteFile(filepath.Join(root, "supervised-mode"), []byte("1\n"), 0600)
	state := filepath.Join(root, "state")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	done := make(chan error, 1)
	go func() {
		done <- brotoupdate.Supervise(ctx, brotoupdate.SupervisorConfig{Root: root, StateDir: state, STUNServers: ""})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case e := <-done:
			if e != nil {
				t.Error(e)
			}
		case <-time.After(10 * time.Second):
			t.Error("supervisor did not stop its child")
		}
	})
	for {
		raw, _ := os.ReadFile(filepath.Join(root, "active-path"))
		if strings.HasPrefix(string(raw), versions[0]+"\n") {
			break
		}
		select {
		case e := <-done:
			t.Fatalf("supervisor failed: %v", e)
		case <-ctx.Done():
			t.Fatal("first child readiness timed out")
		case <-time.After(25 * time.Millisecond):
		}
	}
	if e = brotoupdate.Activate(ctx, brotoupdate.Result{PreviousBinary: versions[0], NextBinary: versions[1], CurrentPointer: pointer}); e != nil {
		t.Fatal(e)
	}
	raw, e := exec.Command(executable, "status", "--state-dir", state).Output()
	if e != nil {
		t.Fatal(e)
	}
	var status struct {
		PID       int `json:"pid"`
		ParentPID int `json:"parentPid"`
	}
	if json.Unmarshal(raw, &status) != nil || status.PID < 1 || status.ParentPID != os.Getpid() {
		t.Fatal("IPC is not the actual supervised child")
	}
}
func TestWindowsServiceDoesNotGrantChangeConfig(t *testing.T) {
	if strings.Contains(windowsInstaller, "CCDCLCSW") {
		t.Fatal("unprivileged service account can change SCM account")
	}
	if !strings.Contains(windowsInstaller, "CCLCSWRPWPDTLOCRRC") || !strings.Contains(windowsInstaller, "service --install-root") {
		t.Fatal("stable least-privilege SCM launcher missing")
	}
}
func TestWindowsAccountIsCheckedBeforeRightsAreGranted(t *testing.T) {
	check := strings.Index(windowsInstaller, "Check(account,password,2);")
	grant := strings.Index(windowsInstaller, `GrantRight(sid,"SeServiceLogonRight")`)
	if check < 0 || grant < 0 || check > grant {
		t.Fatal("logon rights are granted before the account password and administrator check")
	}
}
func TestWindowsInstallerRelaunchesElevatedOnlyOnce(t *testing.T) {
	relaunch := strings.Index(windowsInstaller, "-Verb RunAs")
	guard := strings.Index(windowsInstaller, "if ($Elevated) { throw")
	if guard < 0 || relaunch < 0 || guard > relaunch || !strings.Contains(windowsInstaller, "+' -Elevated'") {
		t.Fatal("installer can relaunch itself without end when Windows does not elevate it")
	}
}
