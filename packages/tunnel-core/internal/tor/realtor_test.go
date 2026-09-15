// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	ps "github.com/mitchellh/go-ps"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

// realTorEnv names the Expert Bundle tor binary for the optional integration
// test, which needs the public Tor network.
const realTorEnv = "CIALAI_TOR_BIN"

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(data)
}

func (buffer *lockedBuffer) tail(lines int) string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	all := strings.Split(strings.TrimSpace(buffer.buffer.String()), "\n")
	return strings.Join(all[max(0, len(all)-lines):], "\n")
}

func requireGone(t *testing.T, name string, pid int) {
	t.Helper()
	if pid <= 0 {
		t.Fatalf("%s pid = %d", name, pid)
	}
	if found, err := ps.FindProcess(pid); err != nil || found != nil {
		t.Fatalf("%s tor %d survived (%v, err %v)", name, pid, found, err)
	}
}

// TestRealTorOnionService covers the CON-023 criteria with the bundled tor:
// computed address equals ADD_ONION, the same address is published on two
// starts, no tor survives Close, and a SOCKS dial reaches the onion with
// pinned TLS.
func TestRealTorOnionService(t *testing.T) {
	executable := os.Getenv(realTorEnv)
	if executable == "" || testing.Short() {
		t.Skip(realTorEnv + " is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute+30*time.Second)
	defer cancel()
	began := time.Now()
	elapsed := func() time.Duration { return time.Since(began).Round(100 * time.Millisecond) }

	// A client Tor dials the service, as the phone's Tor would. It bootstraps
	// while the desktop service starts.
	clientLog := &lockedBuffer{}
	clientDir := filepath.Join(t.TempDir(), "client-tor")
	clientTor, err := launch(ctx, launchSpec{
		creator:    execCreator{path: executable, output: clientLog},
		executable: executable,
		dir:        clientDir,
		role:       roleClient,
		ownerPID:   os.Getpid(),
	})
	if err != nil {
		t.Fatalf("launch client tor: %v\n%s", err, clientLog.tail(30))
	}
	clientPID := clientTor.pid
	defer func() {
		if err := clientTor.stop(defaultShutdownGrace); err != nil {
			t.Errorf("client tor stop: %v", err)
		}
		requireGone(t, "client", clientPID)
		if t.Failed() {
			t.Logf("client tor log:\n%s", clientLog.tail(40))
		}
	}()
	if _, err := clientTor.control.do(ctx, "SETCONF DisableNetwork=0"); err != nil {
		t.Fatal(err)
	}
	listeners, err := clientTor.control.getInfo(ctx, "net/listeners/socks")
	if err != nil {
		t.Fatal(err)
	}
	socksWords, _ := parseArguments(listeners["net/listeners/socks"])
	portFile, err := os.ReadFile(filepath.Join(clientDir, "control-port"))
	if err != nil {
		t.Fatal(err)
	}
	clientControl, _ := parseControlPortFile(string(portFile))
	if len(socksWords) == 0 || clientControl == "" {
		t.Fatalf("client listeners socks=%q control=%q", listeners, clientControl)
	}

	// The ClientAuthV3 flag produces a command real Tor accepts.
	authKey, err := GenerateOnionKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	x25519, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authID, err := clientTor.control.addOnion(ctx, onionRequest{
		key:          authKey,
		virtualPort:  OnionPort,
		target:       "127.0.0.1:9",
		clientAuthV3: []string{strings.ToLower(serviceIDEncoding.EncodeToString(x25519.PublicKey().Bytes()))},
	})
	if err != nil || authID != authKey.ServiceID() {
		t.Fatalf("ADD_ONION with ClientAuthV3 = %q, %v", authID, err)
	}
	if _, err := clientTor.control.do(ctx, "DEL_ONION "+authID); err != nil {
		t.Fatal(err)
	}

	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	desktopLog := &lockedBuffer{}
	config := DesktopConfig{Executable: executable, Dir: paths.Tor, OnionKeyPath: paths.OnionKey, Output: desktopLog}
	defer func() {
		if t.Failed() {
			t.Logf("desktop tor log:\n%s", desktopLog.tail(40))
		}
	}()

	var computed string
	var pids []int
	var second *Desktop
	for run := 1; run <= 2; run++ {
		started := time.Now()
		desktop, err := StartDesktop(config)
		if err != nil {
			t.Fatal(err)
		}
		if run == 1 {
			computed = desktop.Address()
		} else if desktop.Address() != computed {
			_ = desktop.Close()
			t.Fatalf("run 2 computed %s, run 1 %s", desktop.Address(), computed)
		}
		registered, err := desktop.WaitState(ctx, func(state State) bool { return state.Registered != "" })
		if err != nil {
			_ = desktop.Close()
			t.Fatalf("run %d registration: %v (%+v)", run, err, registered)
		}
		if registered.Registered != computed {
			_ = desktop.Close()
			t.Fatalf("run %d ADD_ONION returned %s, computed %s", run, registered.Registered, computed)
		}
		pids = append(pids, desktop.currentPID())
		t.Logf("run %d: computed %s equals ADD_ONION after %s", run, computed, time.Since(started).Round(time.Millisecond))
		state, err := desktop.WaitState(ctx, published)
		if err != nil {
			_ = desktop.Close()
			t.Fatalf("run %d publication: %v (%+v)", run, err, state)
		}
		t.Logf("run %d: descriptor uploaded %s after start (bootstrap %d%%), test clock %s", run, time.Since(started).Round(time.Millisecond), state.Bootstrap.Progress, elapsed())
		if run == 1 {
			stopping := time.Now()
			if err := desktop.Close(); err != nil {
				t.Fatalf("run 1 Close: %v", err)
			}
			requireGone(t, "desktop run 1", pids[0])
			t.Logf("run 1: Close took %s, pid %d gone", time.Since(stopping).Round(time.Millisecond), pids[0])
			continue
		}
		second = desktop
	}
	defer func() {
		stopping := time.Now()
		if err := second.Close(); err != nil {
			t.Errorf("run 2 Close: %v", err)
		}
		requireGone(t, "desktop run 2", pids[1])
		t.Logf("run 2: Close took %s, pid %d gone", time.Since(stopping).Round(time.Millisecond), pids[1])
	}()

	desktopID, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	phoneID, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	serverConfig, err := identity.ServerConfig(desktopID)
	if err != nil {
		t.Fatal(err)
	}
	peers := make(chan string, 4)
	go func() {
		for {
			raw, err := second.Listener().Accept()
			if err != nil {
				return
			}
			go func() {
				conn := tls.Server(raw, serverConfig)
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
				if err := conn.Handshake(); err != nil {
					return
				}
				if peer, err := identity.ServerPeer(conn.ConnectionState(), nil); err == nil {
					peers <- peer.Key
				}
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	client := NewClient()
	if err := client.SetTorEndpoints(Endpoints{SOCKS: socksWords[0], Control: clientControl, CookiePath: clientTor.cookie}); err != nil {
		t.Fatal(err)
	}
	for {
		status, err := client.Bootstrap(ctx)
		if err != nil {
			t.Fatalf("client bootstrap: %v", err)
		}
		if status.Progress == 100 {
			t.Logf("client tor bootstrapped, test clock %s", elapsed())
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("client tor stuck at %+v", status)
		case <-time.After(time.Second):
		}
	}

	dialStarted := time.Now()
	var conn *tls.Conn
	for attempt := 1; ; attempt++ {
		attemptCtx, cancelAttempt := context.WithTimeout(ctx, 90*time.Second)
		conn, err = client.DialTLS(attemptCtx, computed, phoneID, desktopID.PublicKey())
		cancelAttempt()
		if err == nil {
			t.Logf("SOCKS dial and pinned TLS to %s succeeded on attempt %d after %s", computed, attempt, time.Since(dialStarted).Round(time.Millisecond))
			break
		}
		t.Logf("dial attempt %d: %v", attempt, err)
		select {
		case <-ctx.Done():
			t.Fatalf("onion never reachable: %v", err)
		case <-time.After(5 * time.Second):
		}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Minute))
	if _, err := conn.Write([]byte("cialai\n")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 7)
	if _, err := io.ReadFull(conn, echo); err != nil || string(echo) != "cialai\n" {
		t.Fatalf("echo over tor = %q, %v", echo, err)
	}
	if peer := <-peers; peer != phoneID.PublicKeyString() {
		t.Fatalf("desktop saw phone key %s", peer)
	}
	t.Logf("echo over onion ok, test clock %s", elapsed())
}
