// SPDX-License-Identifier: Apache-2.0
package brotoclient

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

const qrBrotoName = "Broto de Teste"

// fastQRTiming keeps the onion out unless a test brings it in.
var fastQRTiming = qrTiming{
	lookupWindow: time.Millisecond, lookupEvery: 10 * time.Millisecond, lookupSlowAfter: time.Minute, lookupSlowEvery: 10 * time.Millisecond,
	onionFirst: time.Hour, onionEvery: time.Hour, onionTimeout: 5 * time.Second, newnymSpacing: time.Hour,
	directTimeout: 5 * time.Second, digitsPoll: 20 * time.Millisecond, approvePoll: 20 * time.Millisecond,
}

func testOnionAddress(t *testing.T, fill byte) string {
	t.Helper()
	key, err := tor.OnionKeyFromSeed(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return key.Address() + ":443"
}

// qrHost is an in-process desktop for the pairing by QR: the edge and the
// pairing sessions behind a direct QUIC listener on loopback. Its marker
// answers lookups once a phone handed it the QR, as with the sidecar.
type qrHost struct {
	desktop  pairing.Desktop
	sessions *pairing.Sessions
	devices  *pairing.Registry
	address  netip.AddrPort

	mu      sync.Mutex
	markers []ed25519.PublicKey
}

func startQRHost(t *testing.T) *qrHost {
	t.Helper()
	desktopIdentity, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	desktop := pairing.Desktop{ID: desktopIdentity.ID(), Name: "Mesa de Teste", PublicKey: desktopIdentity.PublicKeyString()}
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "host"))
	if err != nil {
		t.Fatal(err)
	}
	devices, err := pairing.OpenRegistry(paths, pairing.DesktopIdentity{ID: desktop.ID, Name: desktop.Name, CreatedAt: time.Now()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	sessions := pairing.NewSessions(nil, nil)
	onion := testOnionAddress(t, 3)
	server, err := edge.New(edge.Config{
		StaticDir: t.TempDir(), BridgeURL: "http://127.0.0.1:1", ProxySecret: "broto-qr-test", Desktop: desktop,
		Reach:    func() edge.ReachCard { return edge.ReachCard{Onion: onion, Candidates: []pairing.Candidate{}} },
		Sessions: sessions, Devices: devices,
	})
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: socket, Identity: desktopIdentity})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := endpoint.Listen(direct.ListenConfig{Registry: devices, Pairing: sessions})
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Close(ctx)
		<-served
		_ = endpoint.Close()
	})
	return &qrHost{desktop: desktop, sessions: sessions, devices: devices, address: socket.LocalAddr().(*net.UDPAddr).AddrPort()}
}

// begin is the phone handing the QR to the host.
func (host *qrHost) begin(t *testing.T, payload string) pairing.QRSession {
	t.Helper()
	view, keys, err := host.sessions.BeginQR(payload, host.desktop, "")
	if err != nil {
		t.Fatal(err)
	}
	host.mu.Lock()
	host.markers = append(host.markers, keys.MarkerKey())
	host.mu.Unlock()
	return view
}

func (host *qrHost) lookup(_ context.Context, marker ed25519.PublicKey, _ time.Duration) []netip.AddrPort {
	host.mu.Lock()
	defer host.mu.Unlock()
	for _, announced := range host.markers {
		if bytes.Equal(announced, marker) {
			return []netip.AddrPort{host.address}
		}
	}
	return nil
}

func newQRClient(t *testing.T, seams qrSeams) *Client {
	t.Helper()
	if seams.timing == (qrTiming{}) {
		seams.timing = fastQRTiming
	}
	if seams.onion == nil {
		seams.onion = func(context.Context, string, ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
			return nil, nil, errors.New("no onion in this test")
		}
	}
	if seams.newnym == nil {
		seams.newnym = func(context.Context) error { return nil }
	}
	client, err := New(context.Background(), Config{Dir: t.TempDir(), Name: qrBrotoName, qr: seams})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func waitQRStatus(t *testing.T, client *Client, what string, match func(Status) bool) Status {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		status := client.Status()
		if match(status) {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s: %+v qr=%+v", what, status, status.QR)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func inQRStage(stage string) func(Status) bool {
	return func(status Status) bool { return status.QR != nil && status.QR.Stage == stage }
}

func TestBrotoQRSavesTheHostAfterTheDigitsAndTheApproval(t *testing.T) {
	host := startQRHost(t)
	client := newQRClient(t, qrSeams{lookup: host.lookup})
	shown, err := client.BeginQR()
	if err != nil {
		t.Fatal(err)
	}
	status := client.Status()
	if status.State != "waiting" || status.Digits != "" || status.QR == nil || *status.QR != shown || shown.Stage != qrStageShowing || shown.AttemptsLeft != qrDigitAttempts || shown.Reason != "" {
		t.Fatalf("status after BeginQR: %+v qr=%+v", status, status.QR)
	}
	qr, err := pairing.DecodeQR(shown.Payload)
	if err != nil || qr.Key != client.local.PublicKeyString() || qr.Name != qrBrotoName || qr.Platform != runtime.GOOS || time.Unix(qr.ExpiresAt, 0).UTC().Format(time.RFC3339) != shown.ExpiresAt {
		t.Fatalf("QR %+v: %v", qr, err)
	}
	if _, _, err := client.ConfirmQR("1234"); !errors.Is(err, errQRNotWaiting) {
		t.Fatalf("digits accepted before a host answered: %v", err)
	}

	view := host.begin(t, shown.Payload)
	waitQRStatus(t, client, "the digits stage", inQRStage(qrStageDigits))
	state, err := host.sessions.QRState(view.QRID)
	if err != nil || state.Stage != pairing.QRStageVerify || len(state.Digits) != 4 {
		t.Fatalf("host state: %+v %v", state, err)
	}
	if stage, err := host.sessions.DecideQR(view.QRID, true, ""); err != nil || stage != pairing.QRStageApproved {
		t.Fatalf("approval: %s %v", stage, err)
	}
	// The approval of the phone alone does not finish the pairing.
	time.Sleep(10 * fastQRTiming.digitsPoll)
	if len(host.devices.List()) != 0 || client.Status().QR.Stage != qrStageDigits {
		t.Fatal("the pairing finished without the digits typed on the Broto")
	}
	ok, left, err := client.ConfirmQR(state.Digits)
	if err != nil || !ok || left != qrDigitAttempts {
		t.Fatalf("ConfirmQR = %v %d %v", ok, left, err)
	}
	waitQRStatus(t, client, "the saved host", func(status Status) bool { return status.QR == nil && status.Host == host.desktop.Name })
	saved, err := loadHost(client.paths)
	if err != nil || saved == nil || saved.Card.Desktop != host.desktop || saved.DeviceID != client.local.ID() || !strings.HasPrefix(saved.Token, "cbt1."+client.local.ID()+".") {
		t.Fatalf("saved host %+v: %v", saved, err)
	}
	device, registered := host.devices.RegisteredDevice(client.local.PublicKeyString())
	if !registered || device.Kind != identity.RoleBroto || device.Name != qrBrotoName || device.Platform != runtime.GOOS {
		t.Fatalf("registered device %+v, %v", device, registered)
	}
	if _, valid := host.devices.Authenticate(saved.Token); !valid {
		t.Fatal("the saved token does not authenticate")
	}
	if final, _ := host.sessions.QRState(view.QRID); final.Stage != pairing.QRStageDone {
		t.Fatalf("host stage %s", final.Stage)
	}
}

func TestBrotoQRFailsAfterThreeWrongDigits(t *testing.T) {
	host := startQRHost(t)
	client := newQRClient(t, qrSeams{lookup: host.lookup})
	shown, err := client.BeginQR()
	if err != nil {
		t.Fatal(err)
	}
	view := host.begin(t, shown.Payload)
	waitQRStatus(t, client, "the digits stage", inQRStage(qrStageDigits))
	state, _ := host.sessions.QRState(view.QRID)
	value, _ := strconv.Atoi(state.Digits)
	wrong := fmt.Sprintf("%04d", (value+1)%10000)
	if _, left, err := client.ConfirmQR("12a4"); !errors.Is(err, errQRDigits) || left != qrDigitAttempts {
		t.Fatalf("malformed digits: %d %v", left, err)
	}
	for _, want := range []int{2, 1, 0} {
		if ok, left, err := client.ConfirmQR(wrong); err != nil || ok || left != want {
			t.Fatalf("mismatch with %d left: %v %d %v", want, ok, left, err)
		}
	}
	status := client.Status()
	if status.State != "disconnected" || status.QR == nil || status.QR.Stage != qrStageFailed || status.QR.Reason != qrReasonDigits || status.QR.Payload != "" || status.QR.AttemptsLeft != 0 {
		t.Fatalf("status after the third mismatch: %+v qr=%+v", status, status.QR)
	}
	if _, _, err := client.ConfirmQR(state.Digits); !errors.Is(err, errQRNotWaiting) {
		t.Fatalf("a failed pairing took the right digits: %v", err)
	}
	// The host never gets the confirmation, even once the phone approves.
	if _, err := host.sessions.DecideQR(view.QRID, true, ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * fastQRTiming.approvePoll)
	if len(host.devices.List()) != 0 {
		t.Fatal("the host registered a Broto whose digits never matched")
	}
	if saved, _ := loadHost(client.paths); saved != nil {
		t.Fatal("a failed pairing saved a host")
	}
	client.CancelQR()
	if status := client.Status(); status.QR != nil || status.State != "disconnected" {
		t.Fatalf("status after CancelQR: %+v", status)
	}
}

// fakeQRHost answers the claims of a pairing by QR with a key of its own:
// first a 503, then 202 until the Broto confirms, then the answer of final.
type fakeQRHost struct {
	key *identity.Identity

	mu     sync.Mutex
	final  func() map[string]any
	claims []fakeQRClaim
	events []string
}

type fakeQRClaim struct {
	nonce     string
	confirmed bool
	pinned    bool
}

func (host *fakeQRHost) reset(final func() map[string]any) {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.final, host.claims, host.events = final, nil, nil
}

func (host *fakeQRHost) record(event string) {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.events = append(host.events, event)
}

func (host *fakeQRHost) snapshot() ([]fakeQRClaim, []string) {
	host.mu.Lock()
	defer host.mu.Unlock()
	return slices.Clone(host.claims), slices.Clone(host.events)
}

func (host *fakeQRHost) dial(pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
	if pinned != nil && !bytes.Equal(pinned, host.key.PublicKey()) {
		return nil, nil, errors.New("pinned to another host")
	}
	local, remote := net.Pipe()
	go host.serve(remote, pinned != nil)
	return local, host.key.PublicKey(), nil
}

func (host *fakeQRHost) serve(conn net.Conn, pinned bool) {
	defer conn.Close()
	request, err := http.ReadRequest(bufio.NewReader(conn))
	if err != nil {
		return
	}
	var claim struct {
		Kind      string `json:"kind"`
		Nonce     string `json:"nonce"`
		Confirmed bool   `json:"confirmed"`
	}
	if json.NewDecoder(request.Body).Decode(&claim) != nil || claim.Kind != "broto-qr" {
		writeQRAnswer(conn, http.StatusBadRequest, `{"error":{"code":"payload_invalid"}}`)
		return
	}
	host.mu.Lock()
	host.claims = append(host.claims, fakeQRClaim{nonce: claim.Nonce, confirmed: claim.Confirmed, pinned: pinned})
	count, final := len(host.claims), host.final
	host.mu.Unlock()
	switch {
	case count == 1:
		writeQRAnswer(conn, http.StatusServiceUnavailable, `{"error":{"code":"busy"}}`)
	case !claim.Confirmed:
		writeQRAnswer(conn, http.StatusAccepted, `{"state":"waiting"}`)
	default:
		raw, _ := json.Marshal(final())
		writeQRAnswer(conn, http.StatusOK, string(raw))
	}
}

func writeQRAnswer(conn net.Conn, status int, body string) {
	_, _ = fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", status, http.StatusText(status), len(body), body)
}

// digitsFor computes what the phone of the fake host would show.
func (host *fakeQRHost) digitsFor(t *testing.T, client *Client, payload, nonce string) string {
	t.Helper()
	qr, err := pairing.DecodeQR(payload)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := qr.SecretBytes()
	raw, err := base64.RawURLEncoding.DecodeString(nonce)
	if err != nil {
		t.Fatal(err)
	}
	return pairing.QRDigits(host.key.PublicKey(), client.local.PublicKey(), secret, raw)
}

// confirmFakeQR runs one pairing against the fake host up to the final
// answer and checks the nonces and the pins of every claim on the way.
func confirmFakeQR(t *testing.T, client *Client, fake *fakeQRHost, final func() map[string]any) Status {
	t.Helper()
	fake.reset(final)
	shown, err := client.BeginQR()
	if err != nil {
		t.Fatal(err)
	}
	waitQRStatus(t, client, "the digits stage", inQRStage(qrStageDigits))
	// Let a few polls of the digits stage arrive.
	deadline := time.Now().Add(10 * time.Second)
	for claims, _ := fake.snapshot(); len(claims) < 4; claims, _ = fake.snapshot() {
		if time.Now().After(deadline) {
			t.Fatal("no polls in the digits stage")
		}
		time.Sleep(5 * time.Millisecond)
	}
	claims, _ := fake.snapshot()
	// The first claim failed, so the second carried a fresh nonce; from the
	// first 202 on, the nonce stays and the host key is pinned.
	if claims[0].nonce == claims[1].nonce || claims[0].pinned || claims[1].pinned {
		t.Fatalf("claims before the first answer: %+v", claims[:2])
	}
	for _, claim := range claims[1:] {
		if claim.nonce != claims[1].nonce || claim.confirmed {
			t.Fatalf("claims before the digits: %+v", claims)
		}
	}
	for _, claim := range claims[2:] {
		if !claim.pinned {
			t.Fatalf("a poll after the first answer was not pinned: %+v", claims)
		}
	}
	ok, _, err := client.ConfirmQR(fake.digitsFor(t, client, shown.Payload, claims[1].nonce))
	if err != nil || !ok {
		t.Fatalf("the digits of the fake host did not match: %v %v", ok, err)
	}
	return waitQRStatus(t, client, "the end of the pairing", func(status Status) bool {
		return status.QR == nil || status.QR.Stage == qrStageFailed
	})
}

func TestBrotoQRRefusesAFinalAnswerForAnotherDesktop(t *testing.T) {
	fakeKey, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeQRHost{key: fakeKey}
	lan := []netip.AddrPort{netip.MustParseAddrPort("192.0.2.10:4740")}
	client := newQRClient(t, qrSeams{
		lookup: func(context.Context, ed25519.PublicKey, time.Duration) []netip.AddrPort { return lan },
		direct: func(_ context.Context, addresses []netip.AddrPort, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
			if !slices.Equal(addresses, lan) {
				return nil, nil, errors.New("unexpected addresses")
			}
			return fake.dial(pinned)
		},
	})
	onion := testOnionAddress(t, 5)
	answer := func(desktopID, desktopKey, reachKey string) func() map[string]any {
		return func() map[string]any {
			return map[string]any{
				"deviceId": client.local.ID(), "token": "cbt1." + client.local.ID() + ".fake",
				"desktop": map[string]string{"id": desktopID, "name": "Mesa Falsa", "publicKey": desktopKey},
				"reach":   map[string]any{"onion": onion, "publicKey": reachKey, "candidates": []any{}},
			}
		}
	}
	for _, variant := range []struct {
		name  string
		final func() map[string]any
	}{
		{"another desktop", answer(other.ID(), other.PublicKeyString(), other.PublicKeyString())},
		{"a reach card of another key", answer(fakeKey.ID(), fakeKey.PublicKeyString(), other.PublicKeyString())},
		{"the id of another key", answer(other.ID(), fakeKey.PublicKeyString(), fakeKey.PublicKeyString())},
	} {
		status := confirmFakeQR(t, client, fake, variant.final)
		if status.QR == nil || status.QR.Reason != qrReasonRefused || status.State != "disconnected" {
			t.Fatalf("%s: %+v qr=%+v", variant.name, status, status.QR)
		}
		if saved, _ := loadHost(client.paths); saved != nil {
			t.Fatalf("%s: a refused answer saved a host", variant.name)
		}
	}
	// The same fake host with its own key in the answer is accepted, so only
	// the key made the difference.
	status := confirmFakeQR(t, client, fake, answer(fakeKey.ID(), fakeKey.PublicKeyString(), fakeKey.PublicKeyString()))
	if status.QR != nil || status.Host != "Mesa Falsa" {
		t.Fatalf("the consistent answer: %+v qr=%+v", status, status.QR)
	}
	if saved, err := loadHost(client.paths); err != nil || saved == nil || saved.Card.Desktop.PublicKey != fakeKey.PublicKeyString() {
		t.Fatalf("saved host %+v: %v", saved, err)
	}
}

func TestBrotoQRReachesTheHostThroughTheTemporaryOnion(t *testing.T) {
	fakeKey, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeQRHost{key: fakeKey}
	timing := fastQRTiming
	timing.onionFirst, timing.onionEvery, timing.newnymSpacing = 50*time.Millisecond, 20*time.Millisecond, 0
	client := newQRClient(t, qrSeams{
		timing: timing,
		lookup: func(context.Context, ed25519.PublicKey, time.Duration) []netip.AddrPort {
			fake.record("lookup")
			return nil
		},
		newnym: func(context.Context) error {
			fake.record("newnym")
			return nil
		},
		onion: func(_ context.Context, onion string, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
			fake.record("onion " + onion)
			return fake.dial(pinned)
		},
	})
	fake.reset(func() map[string]any { return nil })
	shown, err := client.BeginQR()
	if err != nil {
		t.Fatal(err)
	}
	waitQRStatus(t, client, "the digits stage", inQRStage(qrStageDigits))
	qr, _ := pairing.DecodeQR(shown.Payload)
	keys, _ := qr.Derive()
	onionKey, _ := tor.OnionKeyFromSeed(keys.OnionSeed[:])
	_, events := fake.snapshot()
	first := slices.IndexFunc(events, func(event string) bool { return strings.HasPrefix(event, "onion ") })
	if first < 1 || events[0] != "lookup" || events[first] != "onion "+onionKey.Address() || events[first-1] != "newnym" {
		t.Fatalf("events: %q", events)
	}
	// Two attempts reached the host: the first one failed, and each went
	// after new circuits.
	if second := slices.IndexFunc(events[first+1:], func(event string) bool { return strings.HasPrefix(event, "onion ") }); second < 0 || events[first+second] != "newnym" {
		t.Fatalf("the second onion attempt did not follow NEWNYM: %q", events)
	}
}

func TestControlServesThePairingByQR(t *testing.T) {
	dir := privateControlDir(t)
	if runtime.GOOS != "windows" {
		t.Setenv("CIALAI_BROTO_SOCKET", filepath.Join(dir, "qr.sock"))
	} else {
		t.Setenv("CIALAI_BROTO_SOCKET", `\\.\pipe\cialai-broto-test-qr-`+strconv.Itoa(os.Getpid()))
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	quiet := qrSeams{
		timing: fastQRTiming,
		lookup: func(context.Context, ed25519.PublicKey, time.Duration) []netip.AddrPort { return nil },
		onion: func(context.Context, string, ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
			return nil, nil, errors.New("no onion in this test")
		},
		newnym: func(context.Context) error { return nil },
	}
	client, err := New(ctx, Config{Dir: dir, Name: qrBrotoName, qr: quiet})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	go func() { _ = client.ServeControl(ctx) }()
	// Wait for the control endpoint before the first real call. Until it
	// listens, Unix refuses the connection and Windows says the pipe does not
	// exist, so any error is retried until the deadline, as in the lifecycle
	// test.
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, err := ControlCall(ctx, dir, "broto.status", nil)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("control did not start: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	call := func(method string, params any) (map[string]any, error) {
		t.Helper()
		raw, err := ControlCall(ctx, dir, method, params)
		var result map[string]any
		if err == nil {
			err = json.Unmarshal(raw, &result)
		}
		return result, err
	}
	if _, err := call("broto.qr.confirm", map[string]string{"digits": "1234"}); err == nil || err.Error() != errQRNotWaiting.Error() {
		t.Fatalf("confirm without a QR: %v", err)
	}
	begun, err := call("broto.qr.begin", nil)
	if err != nil || len(begun) != 2 || !strings.HasPrefix(begun["payload"].(string), pairing.QRPrefix) {
		t.Fatalf("broto.qr.begin = %v, %v", begun, err)
	}
	if _, err := time.Parse(time.RFC3339, begun["expiresAt"].(string)); err != nil {
		t.Fatal(err)
	}
	status, err := call("broto.status", nil)
	if err != nil {
		t.Fatal(err)
	}
	qr, _ := status["qr"].(map[string]any)
	if status["state"] != "waiting" || status["digits"] != "" || qr["payload"] != begun["payload"] || qr["expiresAt"] != begun["expiresAt"] || qr["stage"] != qrStageShowing || qr["attemptsLeft"] != float64(qrDigitAttempts) || qr["reason"] != nil {
		t.Fatalf("broto.status = %v", status)
	}
	if cancelled, err := call("broto.qr.cancel", nil); err != nil || len(cancelled) != 0 {
		t.Fatalf("broto.qr.cancel = %v, %v", cancelled, err)
	}
	if status, err = call("broto.status", nil); err != nil || status["qr"] != nil || status["state"] != "disconnected" {
		t.Fatalf("broto.status after cancel = %v, %v", status, err)
	}
}
