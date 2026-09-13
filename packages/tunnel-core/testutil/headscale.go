// SPDX-License-Identifier: Apache-2.0
//go:build integration

// Package testutil starts disposable infrastructure for the tunnel-core
// integration suite. Nothing here talks to a server owned by the user.
package testutil

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/types/key"
)

const HeadscaleImage = "headscale/headscale:0.29.3"

// Policy mirrors infra/headscale/config/policy.json without comments.
const Policy = `{"grants":[{"src":["autogroup:member"],"dst":["autogroup:self"],"ip":["tcp:4740"]}],"tagOwners":{},"ssh":[]}`

type Headscale struct {
	t      *testing.T
	URL    string
	name   string
	client *http.Client
	mu     sync.RWMutex
	apiKey string
}

type PreAuthKey struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

type Node struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	NodeKey string `json:"nodeKey"`
}

// StartHeadscale runs the pinned image on loopback with a local DERP relay
// whose certificate is pinned by hash, the same shape proven by spike 3.
func StartHeadscale(t *testing.T) *Headscale {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Fatal("Docker is required for the integration suite")
	}
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	hs := &Headscale{
		t:      t,
		URL:    fmt.Sprintf("http://127.0.0.1:%d", port),
		name:   fmt.Sprintf("cialai-integration-%d", time.Now().UnixNano()),
		client: &http.Client{Timeout: 10 * time.Second},
	}
	relay := derpserver.New(key.NewNode(), func(string, ...any) {})
	relayHTTP := httptest.NewTLSServer(derpserver.Handler(relay))
	t.Cleanup(func() { _ = relay.Close(); relayHTTP.Close() })
	relayPort := relayHTTP.Listener.Addr().(*net.TCPAddr).Port
	relayCert := sha256.Sum256(relayHTTP.Certificate().Raw)
	config := fmt.Sprintf(`server_url: %s
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
noise:
  private_key_path: /var/lib/headscale/noise.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
derp:
  server:
    enabled: false
  urls: []
  paths: [/etc/headscale/derp.yaml]
  auto_update_enabled: false
disable_check_updates: true
node:
  expiry: 0
  ephemeral:
    inactivity_timeout: 30m
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
policy:
  mode: file
  path: /etc/headscale/policy.json
dns:
  magic_dns: true
  base_domain: cialai.internal
  override_local_dns: false
  nameservers:
    global: []
unix_socket: /var/lib/headscale/headscale.sock
logtail:
  enabled: false
log:
  level: error
`, hs.URL)
	derp := fmt.Sprintf("regions:\n  999:\n    regionid: 999\n    regioncode: test\n    regionname: Local test relay\n    nodes:\n      - name: test\n        regionid: 999\n        hostname: 127.0.0.1\n        ipv4: 127.0.0.1\n        ipv6: none\n        certname: sha256-raw:%x\n        derpport: %d\n        stunport: -1\n", relayCert, relayPort)
	for name, data := range map[string]string{"config.yaml": config, "policy.json": Policy, "derp.yaml": derp} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Docker Desktop resolves macOS /var paths through /private/var.
	if dir, err = filepath.EvalSymlinks(dir); err != nil {
		t.Fatal(err)
	}
	hs.docker("run", "--detach", "--rm", "--name", hs.name,
		"--label", "br.com.ordinum.cialai.integration=headscale", "--publish", fmt.Sprintf("127.0.0.1:%d:8080", port),
		"--mount", "type=bind,src="+dir+",dst=/etc/headscale,readonly", "--tmpfs", "/var/lib/headscale", HeadscaleImage, "serve")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := exec.CommandContext(ctx, "docker", "rm", "--force", hs.name).Run(); err != nil {
			t.Errorf("cleanup failed for %s: %v", hs.name, err)
		}
	})
	deadline := time.Now().Add(45 * time.Second)
	for {
		res, err := hs.client.Get(hs.URL + "/health")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("Headscale did not become healthy within 45 seconds")
		}
		time.Sleep(200 * time.Millisecond)
	}
	hs.apiKey = strings.TrimSpace(string(hs.docker("exec", hs.name, "headscale", "apikeys", "create", "--expiration", "2h")))
	if !strings.HasPrefix(hs.apiKey, "hskey-api-") {
		t.Fatal("unexpected API key format; value withheld")
	}
	return hs
}

func (hs *Headscale) APIKey() string {
	hs.mu.RLock()
	defer hs.mu.RUnlock()
	return hs.apiKey
}

func (hs *Headscale) SetAPIKey(value string) {
	hs.mu.Lock()
	hs.apiKey = value
	hs.mu.Unlock()
}

func (hs *Headscale) docker(args ...string) []byte {
	hs.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		hs.t.Fatalf("Docker command failed: %v; output withheld to protect credentials", err)
	}
	return output
}

// Status performs an authenticated request and returns only the HTTP status.
func (hs *Headscale) Status(apiKey, method, path string) int {
	hs.t.Helper()
	req, err := http.NewRequest(method, hs.URL+path, nil)
	if err != nil {
		hs.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	res, err := hs.client.Do(req)
	if err != nil {
		hs.t.Fatal("Headscale API transport failed")
	}
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res.StatusCode
}

func (hs *Headscale) API(method, path string, data, result any) {
	hs.t.Helper()
	var body io.Reader
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			hs.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, hs.URL+path, body)
	if err != nil {
		hs.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+hs.APIKey())
	req.Header.Set("Content-Type", "application/json")
	res, err := hs.client.Do(req)
	if err != nil {
		hs.t.Fatal("Headscale API transport failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		hs.t.Fatalf("%s %s: HTTP %d; body withheld", method, path, res.StatusCode)
	}
	if result != nil {
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(result); err != nil {
			hs.t.Fatal("unexpected Headscale API response shape")
		}
	}
}

func (hs *Headscale) CreateUser(name string) string {
	hs.t.Helper()
	var result struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	hs.API(http.MethodPost, "/api/v1/user", map[string]string{"name": name, "displayName": name}, &result)
	if result.User.ID == "" {
		hs.t.Fatal("user ID missing")
	}
	return result.User.ID
}

func (hs *Headscale) CreatePreAuthKey(userID string) PreAuthKey {
	hs.t.Helper()
	var result struct {
		Key PreAuthKey `json:"preAuthKey"`
	}
	hs.API(http.MethodPost, "/api/v1/preauthkey", map[string]any{
		"user": userID, "expiration": time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
		"reusable": false, "ephemeral": false, "aclTags": []string{},
	}, &result)
	if result.Key.ID == "" || result.Key.Key == "" {
		hs.t.Fatal("preauth key response incomplete")
	}
	return result.Key
}

func (hs *Headscale) Nodes() []Node {
	hs.t.Helper()
	var result struct {
		Nodes []Node `json:"nodes"`
	}
	hs.API(http.MethodGet, "/api/v1/node", nil, &result)
	return result.Nodes
}
