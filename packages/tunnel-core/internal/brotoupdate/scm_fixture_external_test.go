// SPDX-License-Identifier: Apache-2.0
package brotoupdate_test

import (
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoinstall"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This entry is used only by the disposable Windows SCM harness. It activates
// a signature-verified prepared version through the production updater API.
func TestDisposableSCMFixtureActivation(t *testing.T) {
	if os.Getenv("CIALAI_BROTO_SCM_FIXTURE") != "YES" {
		t.Skip("requires the isolated SCM fixture")
	}
	root := os.Getenv("CIALAI_BROTO_VALIDATION_ROOT")
	if !strings.Contains(strings.ToLower(root), "broto-scm-") {
		t.Fatal("not a disposable SCM root")
	}
	pointer := filepath.Join(root, "current-path")
	raw, e := os.ReadFile(pointer)
	if e != nil {
		t.Fatal(e)
	}
	previous := strings.TrimSpace(string(raw))
	key := os.Getenv("CIALAI_BROTO_VALIDATION_KEY")
	current, e := brotoinstall.Verify(context.Background(), filepath.Dir(previous), key)
	if e != nil || current.Version != "broto-v0.0.1" {
		t.Fatal("invalid fixture current release", e)
	}
	payload := os.Getenv("CIALAI_BROTO_VALIDATION_PAYLOAD")
	next, e := brotoinstall.Verify(context.Background(), payload, key)
	if e != nil || next.Version != "broto-v0.0.2" {
		t.Fatal("invalid signed fixture update", e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	installed, e := brotoinstall.Install(ctx, brotoinstall.Config{Payload: payload, PublicKey: key, RootDir: root, Activate: false, StateDir: os.Getenv("CIALAI_BROTO_VALIDATION_STATE")})
	if e != nil {
		t.Fatal(e)
	}
	unlock, e := brotoupdate.LockInstallation(root)
	if e != nil {
		t.Fatal(e)
	}
	defer unlock()
	if e = brotoupdate.Activate(ctx, brotoupdate.Result{Version: next.Version, Target: next.Target, PreviousBinary: previous, NextBinary: installed.Binary, CurrentPointer: pointer, StateDir: os.Getenv("CIALAI_BROTO_VALIDATION_STATE")}); e != nil {
		t.Fatal(e)
	}
	raw, e = os.ReadFile(pointer)
	if e != nil || strings.TrimSpace(string(raw)) != installed.Binary {
		t.Fatal("updated service pointer not committed")
	}
	state := os.Getenv("CIALAI_BROTO_VALIDATION_STATE")
	type processStatus struct {
		PID       int `json:"pid"`
		ParentPID int `json:"parentPid"`
	}
	status := func() processStatus {
		t.Helper()
		output, err := exec.CommandContext(ctx, installed.Binary, "status", "--state-dir", state).Output()
		var value processStatus
		if err != nil || json.Unmarshal(output, &value) != nil || value.PID <= 0 || value.ParentPID <= 0 {
			t.Fatal("fixture service did not report its live child")
		}
		return value
	}
	beforeFailure := status()
	// Simulate a damaged executable after staging, without using another service
	// or changing the SCM account. Only this disposable fixture root is touched.
	broken := filepath.Join(root, "releases", "fixture-damaged", "cialai-broto.exe")
	if e = os.MkdirAll(filepath.Dir(broken), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(broken, []byte("invalid executable fixture"), 0700); e != nil {
		t.Fatal(e)
	}
	failedCtx, stopFailed := context.WithTimeout(ctx, 3*time.Second)
	failure := brotoupdate.Activate(failedCtx, brotoupdate.Result{PreviousBinary: installed.Binary, NextBinary: broken, CurrentPointer: pointer, StateDir: state})
	stopFailed()
	if failure == nil {
		t.Fatal("damaged candidate was accepted")
	}
	raw, e = os.ReadFile(pointer)
	if e != nil || strings.TrimSpace(string(raw)) != installed.Binary {
		t.Fatal("damaged candidate did not restore the previous pointer")
	}
	afterFailure := status()
	if afterFailure.ParentPID != beforeFailure.ParentPID {
		t.Fatal("rollback did not restore a healthy child under the same SCM supervisor")
	}
	t.Log("SCM update and damaged-candidate rollback confirmed with a stable supervisor")
}
