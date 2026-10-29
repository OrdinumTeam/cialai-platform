package edge

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoclient"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
)

func brotoTestSOCKS(t *testing.T, onionTarget, backend string) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
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
				_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
				var header [2]byte
				if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 5 {
					return
				}
				if _, err := io.ReadFull(conn, make([]byte, int(header[1]))); err != nil {
					return
				}
				if _, err := conn.Write([]byte{5, 0}); err != nil {
					return
				}
				var request [5]byte
				if _, err := io.ReadFull(conn, request[:]); err != nil || request[0] != 5 || request[1] != 1 || request[3] != 3 {
					return
				}
				target := make([]byte, int(request[4])+2)
				if _, err := io.ReadFull(conn, target); err != nil {
					return
				}
				host, port, err := net.SplitHostPort(onionTarget)
				if err != nil || string(target[:len(target)-2]) != host || port != "443" || binary.BigEndian.Uint16(target[len(target)-2:]) != 443 {
					return
				}
				upstream, err := net.DialTimeout("tcp", backend, time.Second)
				if err != nil {
					return
				}
				defer upstream.Close()
				if _, err = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
					return
				}
				_ = conn.SetDeadline(time.Time{})
				go func() { _, _ = io.Copy(upstream, conn); _ = upstream.Close() }()
				_, _ = io.Copy(conn, upstream)
			}()
		}
	}()
	return listener.Addr().String()
}

func TestBrotoDaemonTorFallbackAndPrivateRestart(t *testing.T) {
	h := prepareEdge(t, "http://127.0.0.1:1")
	h.clock.mu.Lock()
	h.clock.now = time.Now()
	h.clock.mu.Unlock()
	hub := brotorpc.NewHub()
	defer hub.Close()
	hub.Level = func(string) string { return "free" }
	hub.Disconnect = func(id string) { _ = h.config.Devices.Revoke(id) }
	h.server.config.Broto = hub.Attach
	listeners := startRealListeners(t, h)
	h.server.config.Reach = func() ReachCard { return ReachCard{Onion: h.onion, Candidates: []pairing.Candidate{}} }
	socks := brotoTestSOCKS(t, h.onion, listeners.onion.Addr().String())
	endpoints := tor.Endpoints{SOCKS: socks}
	active, err := h.config.Sessions.BeginBroto(pairing.Payload{Desktop: h.config.Desktop, Onion: h.onion, Candidates: []pairing.Candidate{}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := t.TempDir()
	client, err := brotoclient.New(ctx, brotoclient.Config{Dir: dir, TorEndpoints: &endpoints, STUNServers: []string{}, AllowPrivileged: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Close() }()
	wait := func(check func() bool) {
		t.Helper()
		for !check() {
			select {
			case <-ctx.Done():
				t.Fatal("timeout", client.Status())
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
	if err = client.Connect(active.Payload); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return len(h.config.Sessions.PendingBrotos()) == 1 })
	if err = h.config.Sessions.DecideBroto(active.PairID, true); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return client.Status().State == "connected" })
	if client.Status().Transport != "tor" {
		t.Fatal("fallback was not Tor")
	}
	id := h.config.Devices.List()[0].ID
	wait(func() bool { online, _ := hub.State(id); return online })
	wait(func() bool { online, _ := hub.State(id); return online })
	args := json.RawMessage(`{"command":"/bin/sh","args":["-c","printf tor-daemon"]}`)
	if runtime.GOOS == "windows" {
		args = json.RawMessage(`{"command":"cmd.exe","args":["/c","echo tor-daemon"]}`)
	}
	result, err := hub.Call(ctx, id, "exec", "human", args)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), "tor-daemon") {
		t.Fatalf("unexpected execution result %s", result)
	}
	if info, err := os.Stat(filepath.Join(dir, "host.json")); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("host state not private")
	}
	if err = client.Close(); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { online, _ := hub.State(id); return !online })
	client, err = brotoclient.New(ctx, brotoclient.Config{Dir: dir, TorEndpoints: &endpoints, STUNServers: []string{}, AllowPrivileged: true})
	if err != nil {
		t.Fatal(err)
	}
	wait(func() bool { online, _ := hub.State(id); return client.Status().State == "connected" && online })
	if _, err = hub.Call(ctx, id, "exec", "ai", args); err != nil {
		t.Fatal("restart lost pairing", err)
	}
	client.Pause(true)
	wait(func() bool { _, paused := hub.State(id); return paused })
	if _, err = hub.Call(ctx, id, "exec", "ai", args); err == nil {
		t.Fatal("paused Tor executor accepted mutation")
	}
	client.Pause(false)
	wait(func() bool { _, paused := hub.State(id); return !paused })
	if err = client.Disconnect(); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { device, _ := h.config.Devices.Get(id); return device.Revoked })
	if _, err = os.Stat(filepath.Join(dir, "host.json")); !os.IsNotExist(err) {
		t.Fatal("disconnect retained credential")
	}
}
