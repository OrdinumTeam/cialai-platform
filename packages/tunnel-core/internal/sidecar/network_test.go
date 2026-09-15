// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

// realTorEnv names the Expert Bundle tor for the optional test over the
// public Tor network, as in internal/tor.
const realTorEnv = "CIALAI_TOR_BIN"

type pairResponse struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	Desktop  struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
	} `json:"desktop"`
	Reach struct {
		Onion      string              `json:"onion"`
		PublicKey  string              `json:"publicKey"`
		Candidates []pairing.Candidate `json:"candidates"`
	} `json:"reach"`
}

// postPair sends POST /pair v2 on conn, one transport stream.
func postPair(t *testing.T, conn net.Conn, payload pairing.Payload, phone *identity.Identity) pairResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"v": 2, "pairId": payload.PairID, "secret": payload.Secret,
		"device": map[string]string{"name": "iPhone de Teste", "model": "iPhone16,1", "platform": "ios", "app": "1.0.0", "publicKey": phone.PublicKeyString()},
	})
	request, err := http.NewRequest(http.MethodPost, "http://cialai/pair", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	_ = conn.SetDeadline(time.Now().Add(testTimeout))
	if err := request.Write(conn); err != nil {
		t.Fatalf("write /pair: %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), request)
	if err != nil {
		t.Fatalf("read /pair: %v", err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("/pair answered %d: %s", response.StatusCode, data)
	}
	var paired pairResponse
	if err := json.Unmarshal(data, &paired); err != nil {
		t.Fatalf("/pair body %s: %v", data, err)
	}
	return paired
}

// openPTY upgrades /pty with the device token over streams from dial and
// checks the fake bridge echo.
func openPTY(t *testing.T, dial func(context.Context) (net.Conn, error), token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*testTimeout)
	defer cancel()
	client := &http.Client{Transport: &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx) },
		DisableKeepAlives: true,
	}}
	socket, response, err := websocket.Dial(ctx, "ws://cialai/pty", &websocket.DialOptions{
		HTTPClient: client, HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
	})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("upgrade /pty: %v (HTTP %d)", err, status)
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","version":1}`)); err != nil {
		t.Fatal(err)
	}
	kind, data, err := socket.Read(ctx)
	if err != nil || kind != websocket.MessageText || string(data) != `{"type":"hello","version":1}` {
		t.Fatalf("bridge echo: %v %q", err, data)
	}
	return socket
}

func beginPairing(t *testing.T, h *harness) pairing.Payload {
	t.Helper()
	var begun struct {
		Payload string `json:"payload"`
	}
	h.call(t, "pair.begin", map[string]any{"ttlSeconds": 600}, &begun)
	payload, err := pairing.Decode(begun.Payload)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

// TestNetStartPairsAPhoneOverQUICAndOpensThePTY is the desktop composition
// end to end in process: net.start without Tor, pair.begin, a Go phone that
// pins the key from the QR, POST /pair v2 over the direct QUIC session, the
// control channel with the reach card, /pty with the token against a fake
// bridge and the revocation.
func TestNetStartPairsAPhoneOverQUICAndOpensThePTY(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	status := h.start(t, map[string]any{"stun": []string{}, "tor": false})
	payload := beginPairing(t, h)
	pinned, err := identity.ParsePublicKey(payload.Desktop.PublicKey)
	if err != nil {
		t.Fatal(err)
	}

	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: socket, Identity: phone})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	// The candidates on loopback are empty, so the phone dials the port the
	// status reports, pinning the key from the QR.
	session, err := endpoint.Dial(ctx, net.JoinHostPort("127.0.0.1", strconv.Itoa(status.Direct.Port)), pinned)
	if err != nil {
		t.Fatal(err)
	}
	pairStream, err := session.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	paired := postPair(t, pairStream, payload, phone)
	_ = pairStream.Close()
	if paired.Desktop.ID != status.Desktop.ID || paired.Reach.Onion != payload.Onion || paired.Reach.PublicKey != payload.Desktop.PublicKey || !strings.HasPrefix(paired.Token, "cdt1.") {
		t.Fatalf("pair response: %+v", paired)
	}
	h.waitEvent(t, "pair.completed", 0, testTimeout, func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID)
	})

	// The session opened as restricted; a new QUIC session is registered
	// from the handshake and carries the control channel.
	registered, err := endpoint.Dial(ctx, net.JoinHostPort("127.0.0.1", strconv.Itoa(status.Direct.Port)), pinned)
	if err != nil {
		t.Fatal(err)
	}
	reach := make(chan candidates.Card, 4)
	control, err := rendezvous.Open(ctx, registered.(transport.ControlSession), rendezvous.Config{
		Role: identity.RolePhone, LocalKey: phone.PublicKeyString(),
		Handler: rendezvous.Handler{ReachUpdate: func(card candidates.Card) {
			select {
			case reach <- card:
			default:
			}
		}},
	})
	if err != nil {
		t.Fatalf("control channel: %v", err)
	}
	defer control.Close()
	select {
	case card := <-reach:
		if card.Onion != payload.Onion || card.Desktop.ID != status.Desktop.ID || card.Desktop.PublicKey != payload.Desktop.PublicKey {
			t.Fatalf("reach update: %+v", card)
		}
	case <-time.After(testTimeout):
		t.Fatal("no reach update on the control channel")
	}
	if err := control.ReportPath(ctx, rendezvous.PathReport{Path: transport.NameDirect, Address: registered.RemoteAddr().String(), RTTMillis: 1}); err != nil {
		t.Fatal(err)
	}
	h.waitEvent(t, "path.changed", 0, testTimeout, func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID) && strings.Contains(string(data), `"path":"direct"`)
	})

	pty := openPTY(t, func(ctx context.Context) (net.Conn, error) { return registered.OpenStream(ctx) }, paired.Token)
	defer pty.CloseNow()
	upgrades := h.bridge.headers()
	if len(upgrades) != 1 || upgrades[0].Get("X-Cialai-Device-Id") != paired.DeviceID || upgrades[0].Get("X-Cialai-Device-Key") != phone.PublicKeyString() || upgrades[0].Get("X-Cialai-Transport") != "direct" || upgrades[0].Get("Authorization") != "" {
		t.Fatalf("bridge identity headers: %+v", upgrades)
	}
	h.waitEvent(t, "session.opened", 0, testTimeout, func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID) && strings.Contains(string(data), phone.PublicKeyString())
	})
	var listed struct {
		Devices []DeviceView `json:"devices"`
	}
	h.call(t, "devices.list", map[string]any{}, &listed)
	if len(listed.Devices) != 1 || !listed.Devices[0].Connected || len(listed.Devices[0].Transports) != 1 || listed.Devices[0].Transports[0] != "direct" {
		t.Fatalf("connected device: %+v", listed.Devices)
	}
	var live NetStatus
	h.call(t, "net.status", map[string]any{}, &live)
	if live.Sessions.Direct < 1 || live.Sessions.Tor != 0 {
		t.Fatalf("session counts: %+v", live.Sessions)
	}

	var revoked struct {
		Sessions int `json:"sessions"`
		Sockets  int `json:"sockets"`
	}
	h.call(t, "devices.revoke", map[string]any{"deviceId": paired.DeviceID}, &revoked)
	if revoked.Sessions < 1 {
		t.Fatalf("revocation closed no session: %+v", revoked)
	}
	select {
	case <-registered.Done():
	case <-time.After(testTimeout):
		t.Fatal("revoked session stayed open")
	}
	h.waitEvent(t, "session.closed", 0, testTimeout, func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID)
	})
	// The QUIC handshake completes before the listener checks the registry,
	// so the refusal of the revoked key arrives as the session closing.
	if again, err := endpoint.Dial(ctx, net.JoinHostPort("127.0.0.1", strconv.Itoa(status.Direct.Port)), pinned); err == nil {
		select {
		case <-again.Done():
		case <-time.After(testTimeout):
			t.Fatal("the listener kept a session of the revoked key")
		}
	}
}

// TestNetStartServesTheControlChannelOverTheOnion pairs a phone over QUIC and
// then opens the rendezvous channel through the onion listener of a fake Tor,
// with the control ALPN: the desktop renews the reach card and sends its
// candidates on it, relays the path report, keeps it out of the sessions and
// closes it on revocation, after which the key opens no control channel.
func TestNetStartServesTheControlChannelOverTheOnion(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan *fakeTor, 1)
	h := startHarness(t, harnessOptions{
		torExecutable: executable,
		startTor: func(config tor.DesktopConfig) (TorService, error) {
			fake, err := startFakeTor(config)
			if err == nil {
				started <- fake
			}
			return fake, err
		},
	})
	status := h.start(t, map[string]any{"stun": []string{}})
	fake := <-started
	payload := beginPairing(t, h)
	pinned, err := identity.ParsePublicKey(payload.Desktop.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: socket, Identity: phone})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 2*testTimeout)
	defer cancel()
	session, err := endpoint.Dial(ctx, net.JoinHostPort("127.0.0.1", strconv.Itoa(status.Direct.Port)), pinned)
	if err != nil {
		t.Fatal(err)
	}
	pairStream, err := session.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	paired := postPair(t, pairStream, payload, phone)
	_ = pairStream.Close()
	_ = session.Close()

	onionAddress := fake.Listener().Addr().String()
	openControl := func(handler rendezvous.Handler) (*rendezvous.Conn, error) {
		config, err := identity.ControlClientConfig(phone, pinned)
		if err != nil {
			return nil, err
		}
		conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", onionAddress)
		if err != nil {
			return nil, err
		}
		return rendezvous.Establish(ctx, conn, rendezvous.Config{
			Role: identity.RolePhone, LocalKey: phone.PublicKeyString(), PeerKey: payload.Desktop.PublicKey,
			HelloTimeout: testTimeout, Handler: handler,
		})
	}
	reach := make(chan candidates.Card, 4)
	peerCandidates := make(chan rendezvous.CandidateSet, 4)
	var order []string
	var orderMu sync.Mutex
	control, err := openControl(rendezvous.Handler{
		ReachUpdate: func(card candidates.Card) {
			orderMu.Lock()
			order = append(order, "reach_update")
			orderMu.Unlock()
			reach <- card
		},
		Candidates: func(set rendezvous.CandidateSet) {
			orderMu.Lock()
			order = append(order, "candidates")
			orderMu.Unlock()
			peerCandidates <- set
		},
	})
	if err != nil {
		t.Fatalf("control channel over the onion: %v", err)
	}
	defer control.Close()
	select {
	case card := <-reach:
		if card.Onion != payload.Onion || card.Desktop.ID != status.Desktop.ID || card.Desktop.PublicKey != payload.Desktop.PublicKey {
			t.Fatalf("reach update over the onion: %+v", card)
		}
	case <-ctx.Done():
		t.Fatal("no reach update over the onion")
	}
	select {
	case <-peerCandidates:
	case <-ctx.Done():
		t.Fatal("no candidates over the onion")
	}
	orderMu.Lock()
	if !slices.Equal(order[:2], []string{"reach_update", "candidates"}) {
		t.Fatalf("control messages arrived as %v, want the card first", order)
	}
	orderMu.Unlock()
	if err := control.ReportPath(ctx, rendezvous.PathReport{Path: transport.NameTor, Reason: "sem candidatos"}); err != nil {
		t.Fatal(err)
	}
	h.waitEvent(t, "path.changed", 0, testTimeout, func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID) && strings.Contains(string(data), `"transport":"tor"`) && strings.Contains(string(data), `"path":"tor"`)
	})
	var live NetStatus
	h.call(t, "net.status", map[string]any{}, &live)
	if live.Sessions.Tor != 0 {
		t.Fatalf("the control connection was counted as a session: %+v", live.Sessions)
	}

	h.call(t, "devices.revoke", map[string]any{"deviceId": paired.DeviceID}, nil)
	select {
	case <-control.Done():
	case <-ctx.Done():
		t.Fatal("revocation left the onion control channel open")
	}
	if again, err := openControl(rendezvous.Handler{}); err == nil {
		_ = again.Close()
		t.Fatal("a revoked phone opened a control channel over the onion")
	}
}

// TestNetStartPairsAPhoneOverTheOnion runs the same pairing through the public
// Tor network with the bundled tor. It needs CIALAI_TOR_BIN and several
// minutes, so it is skipped otherwise.
func TestNetStartPairsAPhoneOverTheOnion(t *testing.T) {
	executable := os.Getenv(realTorEnv)
	if executable == "" || testing.Short() {
		t.Skip(realTorEnv + " is not set")
	}
	began := time.Now()
	elapsed := func() time.Duration { return time.Since(began).Round(100 * time.Millisecond) }
	socks := startClientTor(t, executable)
	h := startHarness(t, harnessOptions{torExecutable: executable})
	status := h.start(t, map[string]any{"stun": []string{}})
	if status.Tor.State == torDisabled || status.Tor.State == torFailed {
		t.Fatalf("tor did not start: %+v", status.Tor)
	}
	payload := beginPairing(t, h)
	h.waitEvent(t, "tor.state", 0, 4*time.Minute, func(data json.RawMessage) bool {
		var event TorStatus
		return json.Unmarshal(data, &event) == nil && event.Published
	})
	t.Logf("onion published after %s", elapsed())

	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	pinned, _ := identity.ParsePublicKey(payload.Desktop.PublicKey)
	client := tor.NewClient()
	if err := client.SetTorEndpoints(tor.Endpoints{SOCKS: socks}); err != nil {
		t.Fatal(err)
	}
	host, _, _ := net.SplitHostPort(payload.Onion)
	dial := func(ctx context.Context) (net.Conn, error) { return dialOnionTLS(ctx, client, host, phone, pinned) }
	conn := retryOnion(t, dial, 3*time.Minute)
	t.Logf("first onion connection after %s", elapsed())
	paired := postPair(t, conn, payload, phone)
	_ = conn.Close()
	t.Logf("paired over Tor after %s", elapsed())

	pty := openPTY(t, dial, paired.Token)
	defer pty.CloseNow()
	t.Logf("pty over Tor after %s", elapsed())
	upgrades := h.bridge.headers()
	if len(upgrades) != 1 || upgrades[0].Get("X-Cialai-Transport") != "tor" || upgrades[0].Get("X-Cialai-Device-Key") != phone.PublicKeyString() {
		t.Fatalf("bridge headers over Tor: %+v", upgrades)
	}
	var live NetStatus
	h.call(t, "net.status", map[string]any{}, &live)
	if live.Sessions.Tor < 1 {
		t.Fatalf("tor sessions: %+v", live.Sessions)
	}
	h.shutdown(t)
	if pids := torProcessesUnder(t, h.paths.Tor); len(pids) != 0 {
		t.Fatalf("tor survived shutdown: %v", pids)
	}
}

func dialOnionTLS(ctx context.Context, client *tor.Client, host string, phone *identity.Identity, pinned ed25519.PublicKey) (net.Conn, error) {
	return client.DialTLS(ctx, host, phone, pinned)
}

func retryOnion(t *testing.T, dial func(context.Context) (net.Conn, error), limit time.Duration) net.Conn {
	t.Helper()
	deadline := time.Now().Add(limit)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		conn, err := dial(ctx)
		cancel()
		if err == nil {
			return conn
		}
		if time.Now().After(deadline) {
			t.Fatalf("onion never answered: %v", err)
		}
		time.Sleep(5 * time.Second)
	}
}

// startClientTor runs a client tor standing in for the phone's Tor and
// returns its SOCKS address once it bootstrapped.
func startClientTor(t *testing.T, executable string) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	dir, err := os.MkdirTemp("", "cialai-client-tor-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, executable,
		"--DataDirectory", filepath.Join(dir, "data"), "--SocksPort", fmt.Sprintf("127.0.0.1:%d", port),
		"--__OwningControllerProcess", strconv.Itoa(os.Getpid()), "--Log", "notice stdout")
	command.Dir = filepath.Dir(executable)
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		_ = command.Wait()
	})
	bootstrapped := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(output)
		done := false
		for scanner.Scan() {
			if !done && strings.Contains(scanner.Text(), "Bootstrapped 100%") {
				done = true
				close(bootstrapped)
			}
		}
	}()
	select {
	case <-bootstrapped:
	case <-time.After(3 * time.Minute):
		t.Fatal("client tor did not bootstrap")
	}
	return fmt.Sprintf("127.0.0.1:%d", port)
}

// torProcessesUnder lists the tor processes whose command line names dir.
func torProcessesUnder(t *testing.T, dir string) []string {
	t.Helper()
	output, err := exec.Command("pgrep", "-f", dir).Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(output))
}
