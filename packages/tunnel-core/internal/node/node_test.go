// SPDX-License-Identifier: Apache-2.0
package node

import (
	"context"
	"errors"
	"net"
	"testing"
)

type fakeEngine struct {
	status         Status
	identity       Identity
	rebinds        int
	restuns        int
	closed         int
	statusFailures int
	logouts        int
}

func (engine *fakeEngine) Up(context.Context) (Status, error) { return engine.status, nil }
func (engine *fakeEngine) Status(context.Context) (Status, error) {
	if engine.statusFailures > 0 {
		engine.statusFailures--
		return Status{}, errors.New("status failed")
	}
	return engine.status, nil
}
func (engine *fakeEngine) Close() error                 { engine.closed++; return nil }
func (engine *fakeEngine) Rebind(context.Context) error { engine.rebinds++; return nil }
func (engine *fakeEngine) Restun(context.Context) error { engine.restuns++; return nil }
func (engine *fakeEngine) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("not used")
}
func (engine *fakeEngine) Listen(string, string) (net.Listener, error) {
	return nil, errors.New("not used")
}
func (engine *fakeEngine) WhoIs(context.Context, string) (Identity, error) {
	return engine.identity, nil
}
func (engine *fakeEngine) Logout(context.Context) error { engine.logouts++; return nil }

func TestManagerOwnsLifecycleAndIndexesPeersByNodeKey(t *testing.T) {
	engine := &fakeEngine{status: Status{
		State: Running,
		Peers: []Peer{{NodeKey: "nodekey:z", Name: "z"}, {NodeKey: "nodekey:a", Name: "a", IP4: "100.64.0.2"}},
	}, identity: Identity{NodeKey: "nodekey:a", NodeID: "5", UserID: "42", IP: "100.64.0.2"}}
	manager := NewManager(func(config Config) (Engine, error) {
		if config.StateDir != "/tmp/state" || config.Hostname != "desktop" {
			t.Fatalf("unexpected config: %#v", config)
		}
		return engine, nil
	})
	status, err := manager.Up(context.Background(), Config{StateDir: "/tmp/state", ControlURL: "https://hs.example.com", Hostname: "desktop"})
	if err != nil {
		t.Fatal(err)
	}
	if status.State != Running || status.Peers[0].NodeKey != "nodekey:a" {
		t.Fatalf("status not normalized: %#v", status)
	}
	peer, ok := manager.Peer("nodekey:a")
	if !ok || peer.IP4 != "100.64.0.2" {
		t.Fatalf("peer not indexed: %#v %v", peer, ok)
	}
	identity, err := manager.WhoIs(context.Background(), "100.64.0.2:1234")
	if err != nil || identity.UserID != "42" {
		t.Fatalf("whois not delegated: %#v %v", identity, err)
	}
	if err := manager.Down(); err != nil || engine.closed != 1 || manager.Snapshot().State != Stopped {
		t.Fatalf("bad shutdown: %v %#v", err, manager.Snapshot())
	}
}

func TestNetworkChangeMarksOfflineThenRebindsAndRestuns(t *testing.T) {
	engine := &fakeEngine{status: Status{State: Running}}
	manager := NewManager(func(Config) (Engine, error) { return engine, nil })
	if _, err := manager.Up(context.Background(), Config{StateDir: "/tmp/state", ControlURL: "https://hs.example.com", Hostname: "desktop"}); err != nil {
		t.Fatal(err)
	}
	if err := manager.NotifyNetworkChange(context.Background(), false); err != nil || manager.Snapshot().State != Offline {
		t.Fatalf("offline transition failed: %v %#v", err, manager.Snapshot())
	}
	if err := manager.NotifyNetworkChange(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if engine.rebinds != 1 || engine.restuns != 1 || manager.Snapshot().State != Running {
		t.Fatalf("network hooks missing: %#v, rebind %d, restun %d", manager.Snapshot(), engine.rebinds, engine.restuns)
	}
}

func TestManagerRejectsInvalidOrDuplicateStarts(t *testing.T) {
	manager := NewManager(func(Config) (Engine, error) { return &fakeEngine{status: Status{State: Running}}, nil })
	if _, err := manager.Up(context.Background(), Config{}); err == nil {
		t.Fatal("accepted incomplete node config")
	}
	config := Config{StateDir: "/tmp/state", ControlURL: "https://hs.example.com", Hostname: "desktop"}
	if _, err := manager.Up(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Up(context.Background(), config); !errors.Is(err, ErrRunning) {
		t.Fatalf("expected duplicate start error, got %v", err)
	}
}

func TestConfigRequiresHTTPSOutsideLoopback(t *testing.T) {
	manager := NewManager(func(Config) (Engine, error) { return &fakeEngine{status: Status{State: Running}}, nil })
	for _, controlURL := range []string{"http://hs.example.com", "ftp://127.0.0.1", "https://user@hs.example.com", "https://hs.example.com?key=value"} {
		if _, err := manager.Up(context.Background(), Config{StateDir: "/tmp/state", ControlURL: controlURL, Hostname: "desktop"}); err == nil {
			t.Fatalf("accepted unsafe control URL %q", controlURL)
		}
	}
	for _, controlURL := range []string{"https://hs.example.com", "http://127.0.0.1:8080", "http://[::1]:8080"} {
		manager := NewManager(func(Config) (Engine, error) { return &fakeEngine{status: Status{State: Running}}, nil })
		if _, err := manager.Up(context.Background(), Config{StateDir: "/tmp/state", ControlURL: controlURL, Hostname: "desktop"}); err != nil {
			t.Fatalf("rejected safe control URL %q: %v", controlURL, err)
		}
		_ = manager.Down()
	}
}
