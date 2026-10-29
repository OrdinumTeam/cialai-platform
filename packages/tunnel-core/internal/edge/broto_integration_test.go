// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"context"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoclient"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoexec"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"net"
	"runtime"
	"testing"
	"time"
)

func TestBrotoReverseRPCOverBothTransports(t *testing.T) {
	for _, carrier := range []string{"direct", "tor"} {
		t.Run(carrier, func(t *testing.T) {
			h := prepareEdge(t, "http://127.0.0.1:1")
			hub := brotorpc.NewHub()
			defer hub.Close()
			hub.Level = func(string) string { return "free" }
			h.server.config.Broto = hub.Attach
			listeners := startRealListeners(t, h)
			broto := mustIdentity(t, identity.RoleBroto)
			active, err := h.config.Sessions.BeginBroto(pairing.Payload{Desktop: h.config.Desktop, Onion: h.onion})
			if err != nil {
				t.Fatal(err)
			}
			payload, err := pairing.DecodeBroto(active.Payload)
			if err != nil {
				t.Fatal(err)
			}
			connect := func() net.Conn {
				if carrier == "tor" {
					return listeners.dialOnion(t, broto)
				}
				s, e := listeners.dialDirect(t, broto)
				if e != nil {
					t.Fatal(e)
				}
				t.Cleanup(func() { s.Close() })
				c, e := s.OpenStream(context.Background())
				if e != nil {
					t.Fatal(e)
				}
				return c
			}
			var body map[string]any
			json.Unmarshal(pairBody(active.PairID, payload.Secret, broto.PublicKeyString()), &body)
			body["kind"] = "broto"
			raw, _ := json.Marshal(body)
			c := newStreamClient(t, connect())
			response, _ := c.do(t, "POST", "/pair", raw, nil)
			if response.StatusCode != 202 {
				t.Fatalf("unapproved status %d", response.StatusCode)
			}
			if err = h.config.Sessions.DecideBroto(active.PairID, true); err != nil {
				t.Fatal(err)
			}
			response, data := c.do(t, "POST", "/pair", raw, nil)
			if response.StatusCode != 200 {
				t.Fatalf("pair status %d: %s", response.StatusCode, data)
			}
			var pair struct {
				ID    string `json:"deviceId"`
				Token string `json:"token"`
			}
			if err = json.Unmarshal(data, &pair); err != nil {
				t.Fatal(err)
			}
			c = newStreamClient(t, connect())
			response, _ = c.do(t, "GET", "/broto", nil, map[string]string{"Authorization": "Bearer " + pair.Token, "Connection": "Upgrade", "Upgrade": "cialai-broto"})
			if response.StatusCode != 101 {
				t.Fatalf("upgrade %d", response.StatusCode)
			}
			c.conn.SetDeadline(time.Time{})
			ex := brotoexec.New(brotoexec.Config{AllowExec: true, AllowPTY: true, AllowPrivileged: true})
			defer ex.Close()
			go func() {
				for {
					m, e := brotorpc.Read(c.reader)
					if e != nil {
						return
					}
					v, e := ex.Handle(context.Background(), m.Cmd, m.Args)
					reply := brotorpc.Message{ID: m.ID, OK: e == nil}
					if e != nil {
						reply.Error = e.Error()
					} else {
						reply.Result, _ = json.Marshal(v)
					}
					if brotorpc.Write(c.conn, reply) != nil {
						return
					}
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			for {
				on, _ := hub.State(pair.ID)
				if on {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(time.Millisecond):
				}
			}
			args := `{"command":"/bin/sh","args":["-c","printf broto; printf err >&2; exit 7"]}`
			if runtime.GOOS == "windows" {
				args = `{"command":"cmd.exe","args":["/c","echo broto & exit /b 7"]}`
			}
			result, err := hub.Call(ctx, pair.ID, "exec", "human", json.RawMessage(args))
			if err != nil {
				t.Fatal(err)
			}
			var output struct {
				Exit int `json:"exit_code"`
			}
			if err = json.Unmarshal(result, &output); err != nil || output.Exit != 7 {
				t.Fatalf("exec %s: %v", result, err)
			}
			if _, err = h.server.Revoke(pair.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = hub.Call(ctx, pair.ID, "exec", "human", json.RawMessage(args)); err == nil {
				t.Fatal("revoked connection still executes")
			}
		})
	}
}

func TestBrotoDaemonPairsExecutesPausesAndForgets(t *testing.T) {
	h := prepareEdge(t, "http://127.0.0.1:1")
	h.clock.mu.Lock()
	h.clock.now = time.Now()
	h.clock.mu.Unlock()
	hub := brotorpc.NewHub()
	defer hub.Close()
	hub.Level = func(string) string { return "confirm" }
	hub.Disconnect = func(id string) { h.config.Devices.Revoke(id) }
	h.server.config.Broto = hub.Attach
	listeners := startRealListeners(t, h)
	h.server.config.Reach = func() ReachCard {
		return ReachCard{Onion: h.onion, Candidates: []pairing.Candidate{{Type: pairing.CandidateLAN, Address: listeners.direct.Addr().String()}}}
	}
	active, err := h.config.Sessions.BeginBroto(pairing.Payload{Desktop: h.config.Desktop, Onion: h.onion, Candidates: []pairing.Candidate{{Type: pairing.CandidateLAN, Address: listeners.direct.Addr().String()}}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := brotoclient.New(ctx, brotoclient.Config{Dir: t.TempDir(), Name: "Test Broto", STUNServers: []string{}, AllowPrivileged: true})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.Connect(active.Payload); err != nil {
		t.Fatal(err)
	}
	wait := func(check func() bool) {
		t.Helper()
		for !check() {
			select {
			case <-ctx.Done():
				t.Fatal("timeout", client.Status())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	wait(func() bool { return len(h.config.Sessions.PendingBrotos()) == 1 })
	if len(h.config.Devices.List()) != 0 {
		t.Fatal("registered before approval")
	}
	if err = h.config.Sessions.DecideBroto(active.PairID, true); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return client.Status().State == "connected" })
	id := h.config.Devices.List()[0].ID
	wait(func() bool { online, _ := hub.State(id); return online })
	result := make(chan error, 1)
	args := json.RawMessage(`{"command":"/bin/sh","args":["-c","printf daemon"]}`)
	if runtime.GOOS == "windows" {
		args = json.RawMessage(`{"command":"cmd.exe","args":["/c","echo daemon"]}`)
	}
	go func() { _, err := hub.Call(ctx, id, "exec", "ai", args); result <- err }()
	wait(func() bool { return len(hub.Pending()) == 1 })
	if err = hub.Decide(hub.Pending()[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil {
		t.Fatal(err)
	}
	client.Pause(true)
	wait(func() bool { _, p := hub.State(id); return p })
	if _, err = hub.Call(ctx, id, "exec", "ai", args); err == nil {
		t.Fatal("paused command allowed")
	}
	client.Pause(false)
	wait(func() bool { _, p := hub.State(id); return !p })
	if err = client.Disconnect(); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { d, _ := h.config.Devices.Get(id); return d.Revoked })
	if client.Status().State != "disconnected" {
		t.Fatal("not disconnected")
	}
}
