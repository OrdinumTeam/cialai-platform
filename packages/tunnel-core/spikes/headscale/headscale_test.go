// SPDX-License-Identifier: Apache-2.0
//go:build integration

package headscale_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/spikes/mobileprobe"
	"tailscale.com/derp/derpserver"
	"tailscale.com/tsnet"
	"tailscale.com/types/key"
)

const headscaleImage = "headscale/headscale:0.29.3"

type server struct {
	t    *testing.T
	url  string
	key  string
	name string
	http *http.Client
}

// TestPolicyAndExpiry is phase 0 spike 3. It tests real tsnet nodes against an
// isolated Docker Headscale and a local test relay. It does not claim mobile,
// production TLS or Headscale's embedded DERP validation.
func TestPolicyAndExpiry(t *testing.T) {
	t.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	t.Setenv("TS_LOGS_DIR", t.TempDir())
	hs := startHeadscale(t)
	aliceID := hs.createUser("alice")
	bobID := hs.createUser("bob")
	desktop, desktopIP := hs.node("alice-desktop", hs.authKey(aliceID))
	phone, _ := hs.node("alice-phone", hs.authKey(aliceID))
	stranger, _ := hs.node("bob-phone", hs.authKey(bobID))

	for _, port := range []string{"4740", "4741"} {
		listener, err := desktop.Listen("tcp", ":"+port)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = listener.Close() })
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go func() {
					defer conn.Close()
					_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
					_, _ = io.Copy(conn, conn)
				}()
			}
		}()
	}

	t.Run("same-user-can-connect", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		conn, err := phone.Dial(ctx, "tcp", net.JoinHostPort(desktopIP, "4740"))
		if err != nil {
			t.Fatal("same-user connection failed:", err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		message := []byte("cialai-spike-3")
		if _, err := conn.Write(message); err != nil {
			t.Fatal(err)
		}
		got := make([]byte, len(message))
		if _, err := io.ReadFull(conn, got); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, message) {
			t.Fatal("echo mismatch")
		}
	})

	t.Run("other-user-and-other-port-denied", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			node *tsnet.Server
			port string
		}{
			{"other-user", stranger, "4740"}, {"other-port", phone, "4741"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				conn, err := tc.node.Dial(ctx, "tcp", net.JoinHostPort(desktopIP, tc.port))
				if err == nil {
					conn.Close()
					t.Fatal("policy allowed forbidden connection")
				}
				if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, syscall.ENETUNREACH) {
					t.Fatalf("unexpected local error, denial not proven: %v", err)
				}
			})
		}
	})

	t.Run("peers-hidden-between-users", func(t *testing.T) {
		// Poll a stable window after the successful connection and denial checks.
		for range 6 {
			for _, tc := range []struct {
				node      *tsnet.Server
				ownPrefix string
				minPeers  int
			}{
				{desktop, "alice-", 1}, {phone, "alice-", 1}, {stranger, "bob-", 0},
			} {
				lc, err := tc.node.LocalClient()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				status, err := lc.Status(ctx)
				cancel()
				if err != nil {
					t.Fatal(err)
				}
				if len(status.Peer) < tc.minPeers {
					t.Fatal("same-user peer missing")
				}
				for _, peer := range status.Peer {
					if !strings.HasPrefix(peer.HostName, tc.ownPrefix) {
						t.Fatal("cross-user peer exposed")
					}
				}
			}
			time.Sleep(500 * time.Millisecond)
		}
	})

	t.Run("mobile-probe-reuses-persisted-identity", func(t *testing.T) {
		hs := *hs
		hs.t = t
		dir := t.TempDir()
		probe, err := mobileprobe.Open(dir, hs.url, hs.authKey(aliceID), "alice-mobileprobe")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = probe.Close() })
		if _, err := probe.EchoMillis(desktopIP); err != nil {
			t.Fatal(err)
		}
		if err := probe.Close(); err != nil {
			t.Fatal(err)
		}
		reopened, err := mobileprobe.Open(dir, hs.url, "", "alice-mobileprobe")
		if err != nil {
			t.Fatal("cold restart without new enrollment failed:", err)
		}
		t.Cleanup(func() { _ = reopened.Close() })
		if _, err := reopened.EchoMillis(desktopIP); err != nil {
			t.Fatal(err)
		}
		var nodes struct {
			Nodes []struct {
				Name string `json:"name"`
			} `json:"nodes"`
		}
		hs.api(http.MethodGet, "/api/v1/node", nil, &nodes)
		count := 0
		for _, node := range nodes.Nodes {
			if node.Name == "alice-mobileprobe" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("expected one persisted node, got %d", count)
		}
	})

	t.Run("preauth-expire-by-id", func(t *testing.T) {
		hs := *hs
		hs.t = t
		key := hs.createKey(aliceID)
		hs.api(http.MethodPost, "/api/v1/preauthkey/expire", map[string]any{"id": key.ID}, nil)
		var keys struct {
			Keys []struct {
				ID         string    `json:"id"`
				Expiration time.Time `json:"expiration"`
			} `json:"preAuthKeys"`
		}
		hs.api(http.MethodGet, "/api/v1/preauthkey", nil, &keys)
		for _, got := range keys.Keys {
			if got.ID == key.ID {
				if got.Expiration.IsZero() || got.Expiration.After(time.Now()) {
					t.Fatal("key did not expire")
				}
				return
			}
		}
		t.Fatal("expired key missing from API response")
	})

	t.Run("node-expiry-can-be-disabled", func(t *testing.T) {
		hs := *hs
		hs.t = t
		var nodes struct {
			Nodes []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"nodes"`
		}
		hs.api(http.MethodGet, "/api/v1/node", nil, &nodes)
		for _, node := range nodes.Nodes {
			if node.Name != "alice-desktop" {
				continue
			}
			// grpc-gateway maps these fields to query parameters, not JSON bodies.
			path := "/api/v1/node/" + node.ID + "/expire"
			future := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
			var expiring struct {
				Node struct {
					Expiry *time.Time `json:"expiry"`
				} `json:"node"`
			}
			hs.api(http.MethodPost, path+"?expiry="+future, nil, &expiring)
			if expiring.Node.Expiry == nil || !expiring.Node.Expiry.After(time.Now()) {
				t.Fatal("future node expiry not applied")
			}
			hs.api(http.MethodPost, path+"?disableExpiry=true", nil, nil)
			var result struct {
				Node struct {
					Expiry *time.Time `json:"expiry"`
				} `json:"node"`
			}
			hs.api(http.MethodGet, "/api/v1/node/"+node.ID, nil, &result)
			if result.Node.Expiry != nil && !result.Node.Expiry.IsZero() {
				t.Fatal("node expiry not disabled")
			}
			return
		}
		t.Fatal("desktop node missing")
	})

	t.Run("file-policy-cannot-be-overwritten-through-api", func(t *testing.T) {
		hs := *hs
		hs.t = t
		var before, after struct {
			Policy string `json:"policy"`
		}
		hs.api(http.MethodGet, "/api/v1/policy", nil, &before)
		body := strings.NewReader(`{"policy":"{\"grants\":[]}"}`)
		req, err := http.NewRequest(http.MethodPut, hs.url+"/api/v1/policy", body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+hs.key)
		req.Header.Set("Content-Type", "application/json")
		res, err := hs.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var result struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
			t.Fatal("invalid policy error response")
		}
		if res.StatusCode != http.StatusInternalServerError || !strings.Contains(result.Message, "disabled") {
			t.Fatalf("expected file-mode policy rejection, got HTTP %d", res.StatusCode)
		}
		hs.api(http.MethodGet, "/api/v1/policy", nil, &after)
		if before.Policy == "" || before.Policy != after.Policy {
			t.Fatal("file policy changed through API")
		}
	})
}

func startHeadscale(t *testing.T) *server {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Fatal("Docker is required for this explicit integration test")
	}
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	hs := &server{t: t, url: fmt.Sprintf("http://127.0.0.1:%d", port), name: fmt.Sprintf("cialai-spike3-%d", time.Now().UnixNano()), http: &http.Client{Timeout: 5 * time.Second}}
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
`, hs.url)
	// Pin the ephemeral relay certificate. Never disable TLS verification or
	// depend on an external relay, even in this isolated experiment.
	derp := fmt.Sprintf("regions:\n  999:\n    regionid: 999\n    regioncode: spike\n    regionname: Local test relay\n    nodes:\n      - name: spike\n        regionid: 999\n        hostname: 127.0.0.1\n        ipv4: 127.0.0.1\n        ipv6: none\n        certname: sha256-raw:%x\n        derpport: %d\n        stunport: -1\n", relayCert, relayPort)
	policy := `{"grants":[{"src":["autogroup:member"],"dst":["autogroup:self"],"ip":["tcp:4740"]}],"tagOwners":{},"ssh":[]}`
	for name, data := range map[string]string{"config.yaml": config, "policy.json": policy, "derp.yaml": derp} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
	}
	// Docker Desktop resolves macOS /var paths through /private/var.
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	hs.docker("run", "--detach", "--rm", "--name", hs.name,
		"--label", "br.com.ordinum.cialai.spike=3", "--publish", fmt.Sprintf("127.0.0.1:%d:8080", port),
		"--mount", "type=bind,src="+dir+",dst=/etc/headscale,readonly", "--tmpfs", "/var/lib/headscale", headscaleImage, "serve")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		// Delete only the disposable container created by this test, including its tmpfs.
		if err := exec.CommandContext(ctx, "docker", "rm", "--force", hs.name).Run(); err != nil {
			t.Errorf("cleanup failed for %s: %v", hs.name, err)
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for {
		res, err := hs.http.Get(hs.url + "/health")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("Headscale did not become healthy within 30 seconds")
		}
		time.Sleep(200 * time.Millisecond)
	}
	hs.key = strings.TrimSpace(string(hs.docker("exec", hs.name, "headscale", "apikeys", "create", "--expiration", "1h")))
	if !strings.HasPrefix(hs.key, "hskey-api-") {
		t.Fatal("unexpected API key format; value withheld")
	}
	return hs
}

func (hs *server) docker(args ...string) []byte {
	hs.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", args...)
	output, err := cmd.Output()
	if err != nil {
		hs.t.Fatalf("Docker command failed: %v; output withheld to protect credentials", err)
	}
	return output
}

func (hs *server) api(method, path string, data, result any) {
	hs.t.Helper()
	var body io.Reader
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			hs.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, hs.url+path, body)
	if err != nil {
		hs.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+hs.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := hs.http.Do(req)
	if err != nil {
		hs.t.Fatal("Headscale API transport failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		hs.t.Fatalf("%s %s: HTTP %d; body withheld", method, path, res.StatusCode)
	}
	if result != nil {
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(result); err != nil {
			hs.t.Fatal("unexpected API response shape")
		}
	}
}

func (hs *server) createUser(name string) string {
	var result struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	hs.api(http.MethodPost, "/api/v1/user", map[string]string{"name": name, "displayName": name}, &result)
	if result.User.ID == "" {
		hs.t.Fatal("user ID missing")
	}
	return result.User.ID
}

type preAuthKey struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

func (hs *server) createKey(user string) preAuthKey {
	var result struct {
		Key preAuthKey `json:"preAuthKey"`
	}
	hs.api(http.MethodPost, "/api/v1/preauthkey", map[string]any{
		"user": user, "expiration": time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
		"reusable": false, "ephemeral": false, "aclTags": []string{},
	}, &result)
	if result.Key.ID == "" || result.Key.Key == "" {
		hs.t.Fatal("preauth key response incomplete")
	}
	return result.Key
}

func (hs *server) authKey(user string) string { return hs.createKey(user).Key }

func (hs *server) node(name, key string) (*tsnet.Server, string) {
	hs.t.Helper()
	node := &tsnet.Server{Dir: hs.t.TempDir(), Hostname: name, ControlURL: hs.url, AuthKey: key,
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	hs.t.Cleanup(func() { _ = node.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	status, err := node.Up(ctx)
	if err != nil {
		hs.t.Fatalf("tsnet startup failed for %s; details withheld to protect enrollment data", name)
	}
	for _, ip := range status.TailscaleIPs {
		if ip.Is4() {
			return node, ip.String()
		}
	}
	hs.t.Fatal("tsnet returned no IPv4 address")
	return nil, ""
}
