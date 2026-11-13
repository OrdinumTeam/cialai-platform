// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

// Each dial of TestRealTorQREphemeral waits up to qrDialWait, longer than the
// onion timeout of the Broto in brotoclient, so the log shows how long Tor
// takes instead of a cut attempt. The attempts with NEWNYM start
// qrAttemptEvery apart, as the Broto's do.
const (
	qrDialWait       = 90 * time.Second
	qrAttemptEvery   = 15 * time.Second
	qrNewnymAttempts = 4
)

// TestRealTorQREphemeral measures, with the bundled tor and the public
// network, the onion path of a Broto pairing by QR: a dial before the
// temporary service exists, as the Broto makes while nobody has scanned the
// QR; the service published next to the desktop one; a dial right after the
// upload without NEWNYM, which Tor may refuse because it asked the same HSDirs
// a moment ago; and the dials after NEWNYM. Timings are logged, not asserted.
// It asserts what the pairing relies on: after NEWNYM the onion is reached
// with the desktop key recorded and then pinned, and RemoveEphemeral
// withdraws the service from Tor.
func TestRealTorQREphemeral(t *testing.T) {
	executable := os.Getenv(realTorEnv)
	if executable == "" || testing.Short() {
		t.Skip(realTorEnv + " is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 11*time.Minute)
	defer cancel()
	began := time.Now()
	elapsed := func() time.Duration { return time.Since(began).Round(100 * time.Millisecond) }

	// The client Tor plays the Broto's and bootstraps while the desktop
	// service starts.
	clientTor, endpoints := startClientTor(ctx, t, executable)

	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	desktopLog := &lockedBuffer{}
	desktop, err := StartDesktop(DesktopConfig{Executable: executable, Dir: paths.Tor, OnionKeyPath: paths.OnionKey, Output: desktopLog})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		pid := desktop.currentPID()
		if err := desktop.Close(); err != nil {
			t.Errorf("desktop Close: %v", err)
		}
		if t.Failed() {
			t.Logf("desktop tor log:\n%s", desktopLog.tail(40))
		}
		if pid != 0 {
			requireGone(t, "desktop", pid)
		}
	}()

	desktopID, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	brotoID, err := identity.Generate(identity.RoleBroto, nil)
	if err != nil {
		t.Fatal(err)
	}
	serverConfig, err := identity.ServerConfig(desktopID)
	if err != nil {
		t.Fatal(err)
	}
	// One listener takes the connections of both services, as the edge's
	// does.
	peers := make(chan string, 16)
	go func() {
		for {
			raw, err := desktop.Listener().Accept()
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
					select {
					case peers <- peer.Key:
					default:
					}
				}
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	client := NewClient()
	if err := client.SetTorEndpoints(endpoints); err != nil {
		t.Fatal(err)
	}
	waitClientBootstrap(ctx, t, client)
	t.Logf("client tor bootstrapped, test clock %s", elapsed())
	if state, err := desktop.WaitState(ctx, published); err != nil {
		t.Fatalf("desktop publication: %v (%+v)", err, state)
	}
	t.Logf("desktop service published, test clock %s", elapsed())

	secret := make([]byte, pairing.QRSecretSize)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	keys, err := pairing.DeriveQR(secret)
	if err != nil {
		t.Fatal(err)
	}
	qrKey, err := OnionKeyFromSeed(keys.OnionSeed[:])
	if err != nil {
		t.Fatal(err)
	}
	address, serviceID := qrKey.Address(), qrKey.ServiceID()

	watchCtx, stopWatch := context.WithCancel(ctx)
	fetches := watchDescriptorFetches(watchCtx, t, clientTor.control, serviceID, elapsed)
	defer func() {
		stopWatch()
		<-fetches.done
	}()
	probe := func(label string) (ed25519.PublicKey, error) {
		t.Helper()
		before := fetches.requested()
		started := time.Now()
		dial, cancelDial := context.WithTimeout(ctx, qrDialWait)
		conn, recorded, err := client.DialTLSRecord(dial, address, brotoID)
		cancelDial()
		took := time.Since(started).Round(time.Millisecond)
		if err != nil {
			t.Logf("%s: failed after %s with %d HSDir requests: %v", label, took, fetches.requested()-before, err)
			return nil, err
		}
		_ = conn.Close()
		t.Logf("%s: connected with TLS after %s with %d HSDir requests", label, took, fetches.requested()-before)
		return recorded, nil
	}

	// The Broto dials while nobody has scanned the QR yet.
	if _, err := probe("before the service exists"); err == nil {
		t.Fatal("the QR onion answered before the service existed")
	}

	adding := time.Now()
	added, err := desktop.AddEphemeral(keys.OnionSeed)
	if err != nil || added != address {
		t.Fatalf("AddEphemeral = %q, %v; want %s", added, err, address)
	}
	for !desktop.EphemeralPublished(address) {
		select {
		case <-ctx.Done():
			t.Fatalf("the QR descriptor was never uploaded: %v", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Logf("AddEphemeral to the first HS_DESC UPLOADED: %s, test clock %s", time.Since(adding).Round(time.Millisecond), elapsed())

	// Tor does not ask an HSDir again for the same service within 15
	// minutes. A second probe shows whether the refusal of the first lifts
	// that block.
	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := probe(fmt.Sprintf("without NEWNYM, probe %d", attempt)); err == nil {
			break
		}
	}

	// The Broto's way: NEWNYM, then a dial that records the host key.
	var recorded ed25519.PublicKey
	for attempt := 1; recorded == nil; attempt++ {
		started := time.Now()
		signal, cancelSignal := context.WithTimeout(ctx, 10*time.Second)
		err := client.Newnym(signal)
		cancelSignal()
		if err != nil {
			t.Fatalf("NEWNYM: %v", err)
		}
		t.Logf("NEWNYM %d answered after %s", attempt, time.Since(started).Round(time.Millisecond))
		if recorded, err = probe(fmt.Sprintf("after NEWNYM, attempt %d", attempt)); err == nil {
			break
		}
		if attempt == qrNewnymAttempts {
			t.Fatalf("the QR onion was not reached in %d attempts with NEWNYM", attempt)
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Until(started.Add(qrAttemptEvery))):
		}
	}
	if !bytes.Equal(recorded, desktopID.PublicKey()) {
		t.Fatalf("recorded host key %x, want the desktop key %x", recorded, desktopID.PublicKey())
	}

	// The polls after the first answer pin the recorded key.
	started := time.Now()
	dial, cancelDial := context.WithTimeout(ctx, qrDialWait)
	conn, err := client.DialTLS(dial, address, brotoID, recorded)
	cancelDial()
	if err != nil {
		t.Fatalf("pinned dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Minute))
	if _, err := conn.Write([]byte("cialai\n")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 7)
	if _, err := io.ReadFull(conn, echo); err != nil || string(echo) != "cialai\n" {
		t.Fatalf("echo over the QR onion = %q, %v", echo, err)
	}
	t.Logf("pinned dial and echo: %s", time.Since(started).Round(time.Millisecond))
	for len(peers) > 0 {
		if peer := <-peers; peer != brotoID.PublicKeyString() {
			t.Fatalf("desktop saw key %s, want the Broto's", peer)
		}
	}

	listed, err := listedOnions(ctx, desktop)
	if err != nil || !slices.Contains(listed, serviceID) {
		t.Fatalf("before RemoveEphemeral tor lists %q, %v", listed, err)
	}
	if err := desktop.RemoveEphemeral(address); err != nil {
		t.Fatal(err)
	}
	listed, err = listedOnions(ctx, desktop)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(listed, serviceID) || !slices.Contains(listed, desktop.key.ServiceID()) || desktop.EphemeralPublished(address) {
		t.Fatalf("after RemoveEphemeral tor lists %q", listed)
	}
	t.Logf("RemoveEphemeral: tor lists the desktop service only, test clock %s", elapsed())
}

// startClientTor launches the Tor a Broto or a phone runs next to the app,
// with its network enabled, and returns the endpoints of its client. The Tor
// is stopped, and checked to be gone, when the test ends.
func startClientTor(ctx context.Context, t *testing.T, executable string) (*instance, Endpoints) {
	t.Helper()
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
	t.Cleanup(func() {
		if err := clientTor.stop(defaultShutdownGrace); err != nil {
			t.Errorf("client tor stop: %v", err)
		}
		if t.Failed() {
			t.Logf("client tor log:\n%s", clientLog.tail(40))
		}
		requireGone(t, "client", clientPID)
	})
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
	return clientTor, Endpoints{SOCKS: socksWords[0], Control: clientControl, CookiePath: clientTor.cookie}
}

func waitClientBootstrap(ctx context.Context, t *testing.T, client *Client) {
	t.Helper()
	for {
		status, err := client.Bootstrap(ctx)
		if err != nil {
			t.Fatalf("client bootstrap: %v", err)
		}
		if status.Progress == 100 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("client tor stuck at %+v", status)
		case <-time.After(time.Second):
		}
	}
}

// descriptorFetches logs the HS_DESC events of the client Tor for one
// service, so the log shows which HSDirs were asked and what they answered,
// and counts the requests.
type descriptorFetches struct {
	done chan struct{}

	mu       sync.Mutex
	requests int
}

func watchDescriptorFetches(ctx context.Context, t *testing.T, control *controlConn, serviceID string, clock func() time.Duration) *descriptorFetches {
	t.Helper()
	if _, err := control.do(ctx, "SETEVENTS HS_DESC"); err != nil {
		t.Fatal(err)
	}
	fetches := &descriptorFetches{done: make(chan struct{})}
	go func() {
		defer close(fetches.done)
		for {
			event, err := control.nextEvent(ctx)
			if err != nil {
				return
			}
			name, body, _ := strings.Cut(event, " ")
			words, keywords := parseArguments(body)
			if name != "HS_DESC" || len(words) < 2 || words[1] != serviceID {
				continue
			}
			if words[0] == "REQUESTED" {
				fetches.mu.Lock()
				fetches.requests++
				fetches.mu.Unlock()
			}
			// The HSDir is "$<fingerprint>~<nickname>"; a prefix tells them
			// apart.
			line := fmt.Sprintf("%s client HS_DESC %s", clock(), words[0])
			if len(words) > 3 {
				hsdir, _, _ := strings.Cut(words[3], "~")
				line += " " + hsdir[:min(len(hsdir), 9)]
			}
			if reason := keywords["REASON"]; reason != "" {
				line += " " + reason
			}
			t.Log(line)
		}
	}()
	return fetches
}

func (fetches *descriptorFetches) requested() int {
	fetches.mu.Lock()
	defer fetches.mu.Unlock()
	return fetches.requests
}

// listedOnions returns the services the desktop's Tor lists for the control
// connection that added them.
func listedOnions(ctx context.Context, desktop *Desktop) ([]string, error) {
	desktop.mu.Lock()
	control := desktop.control
	desktop.mu.Unlock()
	if control == nil {
		return nil, errors.New("the desktop tor is not registered")
	}
	query, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	values, err := control.getInfo(query, "onions/current")
	if err != nil {
		return nil, err
	}
	return strings.Fields(values["onions/current"]), nil
}
