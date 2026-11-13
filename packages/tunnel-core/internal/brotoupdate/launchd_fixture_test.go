//go:build darwin

// SPDX-License-Identifier: Apache-2.0
//
package brotoupdate

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestIsolatedNativeLaunchdActivation(t *testing.T) {
	if os.Getenv("CIALAI_BROTO_LAUNCHD_FIXTURE") != "YES" {
		t.Skip("requires explicit isolated launchd fixture opt-in")
	}
	source := os.Getenv("CIALAI_BROTO_TEST_BINARY")
	if source == "" || os.Getuid() == 0 {
		t.Fatal("normal-user CLI fixture required")
	}
	root, e := os.MkdirTemp("/tmp", "broto-activate-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	state := filepath.Join(root, "state")
	socket := filepath.Join(root, "control.sock")
	t.Setenv("CIALAI_BROTO_SOCKET", socket)
	versions := []string{}
	for _, name := range []string{"one", "two"} {
		dir := filepath.Join(root, name)
		os.Mkdir(dir, 0700)
		path := filepath.Join(dir, "cialai-broto")
		input, e := os.Open(source)
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
	home := filepath.Join(root, "descriptor-home")
	dir := filepath.Join(home, "Library", "LaunchAgents")
	os.MkdirAll(dir, 0700)
	path := filepath.Join(dir, "br.com.ordinum.cialai.broto.plist")
	label := fmt.Sprintf("br.com.ordinum.cialai.broto.validation.activate.%d", time.Now().UnixNano())
	domain := "gui/" + strconv.Itoa(os.Getuid())
	if exec.Command("launchctl", "print", domain+"/"+label).Run() == nil {
		t.Fatal("test label already exists")
	}
	actualHome, e := os.UserHomeDir()
	if e != nil {
		t.Fatal(e)
	}
	content := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>%s</string><key>ProgramArguments</key><array><string>%s</string><string>serve</string><string>--state-dir</string><string>%s</string><string>--stun</string><string></string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>%s</string><key>CIALAI_BROTO_SOCKET</key><string>%s</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer><key>Umask</key><integer>63</integer></dict></plist>`, label, versions[0], state, actualHome, socket)
	if e = os.WriteFile(path, []byte(content), 0600); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_ = exec.Command("launchctl", "bootout", domain, path).Run()
		if exec.Command("launchctl", "print", domain+"/"+label).Run() == nil {
			t.Error("isolated launchd job was not removed")
		}
	})
	if e = exec.Command("launchctl", "bootstrap", domain, path).Run(); e != nil {
		t.Fatal(e)
	}
	wait, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var original int
	for {
		original, e = probeServicePID(wait, versions[0], state)
		if e == nil && original > 0 {
			break
		}
		select {
		case <-wait.Done():
			t.Fatal("isolated first service did not become ready")
		case <-time.After(100 * time.Millisecond):
		}
	}
	active, cancelActive := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelActive()
	if e = activateUnix(active, Result{PreviousBinary: versions[0], NextBinary: versions[1], StateDir: state}, home); e != nil {
		t.Fatal(e)
	}
	next, e := probeServicePID(active, versions[1], state)
	if e != nil || next < 1 || next == original {
		t.Fatal("default activation did not replace the healthy process")
	}
	bad := filepath.Join(root, "broken")
	os.WriteFile(bad, []byte("#!/bin/sh\nexit 1\n"), 0700)
	failure, cancelFailure := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFailure()
	if e = activateUnix(failure, Result{PreviousBinary: versions[1], NextBinary: bad, StateDir: state}, home); e == nil {
		t.Fatal("broken candidate was accepted")
	}
	restored, e := probeServicePID(context.Background(), versions[1], state)
	if e != nil || restored < 1 || restored == next {
		t.Fatal("rollback did not restore a new healthy old-version process")
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), versions[1]) || strings.Contains(string(raw), bad) {
		t.Fatal("rollback did not restore service descriptor")
	}
}
