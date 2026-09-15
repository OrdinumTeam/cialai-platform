// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/control"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

type serviceNodeEngine struct {
	status node.Status
}

func (engine *serviceNodeEngine) Up(context.Context) (node.Status, error) { return engine.status, nil }
func (engine *serviceNodeEngine) Status(context.Context) (node.Status, error) {
	return engine.status, nil
}
func (*serviceNodeEngine) Close() error                 { return nil }
func (*serviceNodeEngine) Rebind(context.Context) error { return nil }
func (*serviceNodeEngine) Restun(context.Context) error { return nil }
func (*serviceNodeEngine) Logout(context.Context) error { return nil }
func (*serviceNodeEngine) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("not used")
}
func (*serviceNodeEngine) Listen(string, string) (net.Listener, error) {
	return nil, errors.New("not used")
}
func (*serviceNodeEngine) WhoIs(context.Context, string) (node.Identity, error) {
	return node.Identity{}, errors.New("not used")
}

func serviceRuntime(t *testing.T, factory node.Factory) *runtimeState {
	t.Helper()
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &runtimeState{
		logger:   logx.New(&bytes.Buffer{}, 20),
		writer:   rpc.NewWriter(&bytes.Buffer{}),
		paths:    paths,
		node:     node.NewManager(factory),
		sessions: nil,
	}
}

func TestNodeUpCreatesAndExpiresAnEnrollmentKeyWhenMissing(t *testing.T) {
	var createdUser, expiredID uint64
	runtime := serviceRuntime(t, func(config node.Config) (node.Engine, error) {
		if config.AuthKey != "tskey-auth-generated" {
			t.Fatalf("generated auth key not passed to tsnet: %#v", config)
		}
		return &serviceNodeEngine{status: node.Status{State: node.Running, IP4: "100.64.0.1", NodeKey: "nodekey:desktop"}}, nil
	})
	runtime.admin = &fakeControlAdmin{
		createKey: func(_ context.Context, userID uint64, expiresAt time.Time) (control.PreAuthKey, error) {
			createdUser = userID
			if time.Until(expiresAt) < 9*time.Minute {
				t.Fatalf("enrollment key expires too early: %s", expiresAt)
			}
			return control.PreAuthKey{ID: 81, Key: "tskey-auth-generated", Expiration: expiresAt}, nil
		},
		expireKey: func(_ context.Context, id uint64) error { expiredID = id; return nil },
	}
	_, err := runtime.nodeUp(context.Background(), []byte(`{"controlUrl":"https://hs.example.com","userId":"42","userName":"alice","hostname":"desktop","forceLogin":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if createdUser != 42 || expiredID != 81 {
		t.Fatalf("unexpected enrollment lifecycle: user=%d expired=%d", createdUser, expiredID)
	}
}

func TestNodeUpKeepsAnExplicitEnrollmentKeyWithoutControlAdmin(t *testing.T) {
	runtime := serviceRuntime(t, func(config node.Config) (node.Engine, error) {
		if config.AuthKey != "tskey-auth-explicit" {
			t.Fatalf("explicit auth key changed: %#v", config)
		}
		return &serviceNodeEngine{status: node.Status{State: node.Running}}, nil
	})
	_, err := runtime.nodeUp(context.Background(), []byte(`{"controlUrl":"https://hs.example.com","userId":"42","userName":"alice","hostname":"desktop","authKey":"tskey-auth-explicit","forceLogin":true}`))
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeviceEventsDescribeBridgeIdentityChanges(t *testing.T) {
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	desktopID := "d_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	registry, err := pairing.OpenRegistry(paths, pairing.DesktopIdentity{
		ID: desktopID, Name: "MacBook", CreatedAt: time.Now().UTC(),
	}, nil, bytes.NewReader(bytes.Repeat([]byte{2}, 1024)))
	if err != nil {
		t.Fatal(err)
	}
	device, _, err := registry.Pair(pairing.DeviceInput{
		Name: "iPhone", Model: "iPhone16,1", Platform: "ios", App: "1.0.0",
		NodeKey: "nodekey:" + strings.Repeat("a", 64), NodeID: "17", UserID: "42",
		IP4: "100.64.0.9", RemoteAddr: "100.64.0.9:51234",
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	runtime := &runtimeState{
		logger: logx.New(&bytes.Buffer{}, 20), writer: rpc.NewWriter(&output), paths: paths,
		node:    node.NewManager(func(node.Config) (node.Engine, error) { return nil, errors.New("not used") }),
		devices: registry,
	}

	if _, err := runtime.deviceRename(json.RawMessage(`{"deviceId":"` + device.ID + `","name":"iPhone novo"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.deviceRevoke(context.Background(), json.RawMessage(`{"deviceId":"`+device.ID+`","network":false}`)); err != nil {
		t.Fatal(err)
	}

	decoder := json.NewDecoder(&output)
	var renamed, revoked rpc.Event
	if err := decoder.Decode(&renamed); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&revoked); err != nil {
		t.Fatal(err)
	}
	renameData := renamed.Data.(map[string]any)
	revokeData := revoked.Data.(map[string]any)
	if renamed.Name != "devices.changed" || renameData["deviceId"] != device.ID || renameData["name"] != "iPhone novo" {
		t.Fatalf("rename event cannot update bridge identity: %#v", renamed)
	}
	if revoked.Name != "devices.changed" || revokeData["deviceId"] != device.ID || revokeData["revoked"] != true {
		t.Fatalf("revoke event cannot close bridge connection: %#v", revoked)
	}
}
