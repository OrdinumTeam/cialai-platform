// SPDX-License-Identifier: Apache-2.0
package mobile

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

const (
	desktopNodeKey = "nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	mobileNodeKey  = "nodekey:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

type recordingListener struct {
	mu     sync.Mutex
	events []string
}

func (listener *recordingListener) OnEvent(kind, payload string) {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	listener.events = append(listener.events, kind+":"+payload)
}

type fakeEngine struct{ status node.Status }

func (engine *fakeEngine) Up(context.Context) (node.Status, error)     { return engine.status, nil }
func (engine *fakeEngine) Status(context.Context) (node.Status, error) { return engine.status, nil }
func (engine *fakeEngine) Close() error                                { return nil }
func (engine *fakeEngine) Rebind(context.Context) error                { return nil }
func (engine *fakeEngine) Restun(context.Context) error                { return nil }
func (engine *fakeEngine) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, address)
}
func (engine *fakeEngine) Listen(network, address string) (net.Listener, error) {
	return net.Listen(network, address)
}
func (engine *fakeEngine) WhoIs(context.Context, string) (node.Identity, error) {
	return node.Identity{}, nil
}
func (engine *fakeEngine) Logout(context.Context) error { return nil }

func encodedPayload(t *testing.T, port int) string {
	t.Helper()
	authKey := "hskey-auth-test"
	encoded, err := pairing.Encode(pairing.Payload{
		Version: 1, ControlURL: "https://hs.example.com", UserID: "42", UserName: "foco", AuthKey: &authKey,
		Desktop: pairing.Desktop{ID: "d_" + base64.RawURLEncoding.EncodeToString(make([]byte, 16)), Name: "Mac de Teste", NodeKey: desktopNodeKey, IP4: "127.0.0.1", Port: port},
		Secret:  base64.RawURLEncoding.EncodeToString(make([]byte, 32)), ExpiresAt: time.Now().Add(10 * time.Minute).Unix(),
		PairID: "p_" + base64.RawURLEncoding.EncodeToString(make([]byte, 8)),
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestInspectPairPayloadOmitsSecrets(t *testing.T) {
	stateDir := t.TempDir()
	tunnel, err := NewTunnel(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	inspected, err := tunnel.InspectPairPayload(encodedPayload(t, 4740))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(inspected, "hskey") || strings.Contains(inspected, `"s"`) {
		t.Fatalf("inspection leaked QR secrets: %s", inspected)
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(inspected), &value); err != nil || value["profileMatch"] != "new" {
		t.Fatalf("unexpected inspection: %s", inspected)
	}
}

func TestPairPersistsOnlyNonSecretMetadata(t *testing.T) {
	var requested map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &requested)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"deviceId":"dev_test","token":"cdt1.dev_test.secret","desktop":{"id":"d_AAAAAAAAAAAAAAAAAAAAAA","name":"Mac de Teste","port":4740}}`))
	}))
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "http://")
	_, portText, _ := net.SplitHostPort(address)
	var port int
	_, _ = fmt.Sscan(portText, &port)

	status := node.Status{State: node.Running, NodeKey: mobileNodeKey, Peers: []node.Peer{{NodeKey: desktopNodeKey, IP4: "127.0.0.1", Online: true}}}
	manager := node.NewManager(func(node.Config) (node.Engine, error) { return &fakeEngine{status: status}, nil })
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tunnel := &Tunnel{paths: paths, listener: &recordingListener{}, node: manager, profiles: map[string]storedProfile{}, logLevel: "info"}
	result, err := tunnel.Pair(encodedPayload(t, port), "iPhone de Teste", "iPhone16,1", "ios", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, `"token":"cdt1.dev_test.secret"`) {
		t.Fatalf("pair result did not return native token: %s", result)
	}
	raw, err := os.ReadFile(filepath.Join(paths.Root, mobileStateFile))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "hskey") || strings.Contains(string(raw), "cdt1") || strings.Contains(string(raw), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") {
		t.Fatalf("persisted state contains a secret: %s", raw)
	}
	device := requested["device"].(map[string]any)
	if device["nodeKey"] != mobileNodeKey {
		t.Fatalf("pair request used wrong mobile node key: %#v", device)
	}
}

func TestVersionAndStoppedStatusAreStable(t *testing.T) {
	if Version() != "0.1.0" {
		t.Fatalf("unexpected version %q", Version())
	}
	tunnel, err := NewTunnel(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	status, err := tunnel.StatusJSON()
	if err != nil || !strings.Contains(status, `"state":"stopped"`) {
		t.Fatalf("unexpected stopped status %q, %v", status, err)
	}
}

func TestConnectivityDependenciesExposeQUICAndSOCKSWithoutDialing(t *testing.T) {
	raw, err := connectivityDependenciesJSON("ios", func(string, string) error {
		t.Fatal("iOS must not set the Android ECN workaround")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var info connectivityDependencies
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		t.Fatal(err)
	}
	if info.Platform != "ios" || info.QUICVersion != "v1" || !info.SOCKS5 || info.AndroidECNWorkaround {
		t.Fatalf("unexpected connectivity dependencies: %+v", info)
	}
}

func TestConnectivityDependenciesDisableECNOnAndroid(t *testing.T) {
	var name, value string
	raw, err := connectivityDependenciesJSON("android", func(gotName, gotValue string) error {
		name, value = gotName, gotValue
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if name != quicDisableECNEnvironment || value != "true" || !strings.Contains(raw, `"androidEcnWorkaround":true`) {
		t.Fatalf("Android workaround not prepared: name=%q value=%q payload=%s", name, value, raw)
	}
}
