// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotohostipc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

// TestBrotoExternalPeer is an opt-in lab for an actual external daemon. All
// identities are ephemeral. The operator supplies an empty private directory,
// transfers pairing.code privately, and sends numbered JSON requests there.
// It never reads a production registry or approves a pairing automatically.
func TestBrotoExternalPeer(t *testing.T) {
	dir := os.Getenv("BROTO_EXTERNAL_DIR")
	if dir == "" {
		t.Skip("external peer lab requires BROTO_EXTERNAL_DIR")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatal("lab requires an existing empty private directory")
	}
	if err = os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	h := prepareEdge(t, "http://127.0.0.1:1")
	h.clock.mu.Lock()
	h.clock.now = time.Now()
	h.clock.mu.Unlock()
	hub := brotorpc.NewHub()
	defer hub.Close()
	hub.Level = func(id string) string { d, _ := h.config.Devices.Get(id); return d.Level }
	hub.Disconnect = func(id string) { _ = h.config.Devices.Revoke(id) }
	h.server.config.Broto = hub.Attach
	listeners := startRealListeners(t, h)
	_, port, _ := net.SplitHostPort(listeners.direct.Addr().String())
	address := os.Getenv("BROTO_EXTERNAL_ADDRESS")
	if address == "" {
		address = "127.0.0.1"
	}
	candidates := []pairing.Candidate{{Type: pairing.CandidateLAN, Address: net.JoinHostPort(address, port)}}
	h.server.config.Reach = func() ReachCard { return ReachCard{Onion: h.onion, Candidates: candidates} }
	active, err := h.config.Sessions.BeginBroto(pairing.Payload{Desktop: h.config.Desktop, Onion: h.onion, Candidates: candidates})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "pairing.code"), []byte(active.Payload+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	handle := func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		var p struct {
			DeviceID string          `json:"deviceId"`
			Cmd      string          `json:"cmd"`
			Actor    string          `json:"actor"`
			Args     json.RawMessage `json:"args"`
			ID       uint64          `json:"id"`
			Approve  bool            `json:"approve"`
			Level    string          `json:"level"`
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, err
			}
		}
		switch method {
		case "broto.pair.pending":
			return h.config.Sessions.PendingBrotos(), nil
		case "broto.pair.decide":
			return nil, h.config.Sessions.DecideBroto(active.PairID, p.Approve)
		case "broto.list":
			list := []map[string]any{}
			for _, d := range h.config.Devices.List() {
				online, paused := hub.State(d.ID)
				list = append(list, map[string]any{"id": d.ID, "name": d.Name, "connected": online, "paused": paused, "revoked": d.Revoked})
			}
			return list, nil
		case "broto.permission.set":
			return nil, h.config.Devices.SetBrotoLevel(p.DeviceID, p.Level)
		case "broto.requests":
			return hub.Pending(), nil
		case "broto.decide":
			return nil, hub.Decide(p.ID, p.Approve)
		case "broto.call":
			return hub.Call(ctx, p.DeviceID, p.Cmd, p.Actor, p.Args)
		case "broto.sessions":
			return hub.Call(ctx, p.DeviceID, "pty.list", "ai", json.RawMessage(`{}`))
		default:
			return nil, errors.New("unknown lab method")
		}
	}
	ipcErrors := make(chan error, 1)
	go func() { ipcErrors <- brotohostipc.Serve(ctx, filepath.Join(dir, "host.sock"), handle) }()
	t.Log("external peer lab ready; private pairing and control files created")
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("external lab deadline reached")
		case err := <-ipcErrors:
			t.Fatal("external lab IPC ended", err)
		case <-ticker.C:
			if _, err := os.Stat(filepath.Join(dir, "finish")); err == nil {
				return
			}
			files, err := filepath.Glob(filepath.Join(dir, "request-*.json"))
			if err != nil {
				t.Fatal(err)
			}
			for _, file := range files {
				raw, err := os.ReadFile(file)
				if err != nil {
					t.Fatal(err)
				}
				var req struct {
					ID     uint64          `json:"id"`
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				if err := json.Unmarshal(raw, &req); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				go func() {
					result, err := handle(ctx, req.Method, req.Params)
					response := map[string]any{"result": result}
					if err != nil {
						response["error"] = err.Error()
					}
					data, _ := json.Marshal(response)
					name := filepath.Join(dir, "response-"+strconv.FormatUint(req.ID, 10)+".json")
					if os.WriteFile(name+".tmp", data, 0600) == nil {
						_ = os.Rename(name+".tmp", name)
					}
				}()
			}
		}
	}
}
