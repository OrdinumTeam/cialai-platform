// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/control"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/logx"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/node"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/rpc"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/statedir"
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
