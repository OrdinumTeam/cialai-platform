// SPDX-License-Identifier: Apache-2.0
package mobile

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/testutil"
)

// realTorEnv names the Expert Bundle tor binary for the optional test below,
// which needs the public Tor network.
const realTorEnv = "CIALAI_TOR_BIN"

type torLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (log *torLog) Write(data []byte) (int, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	return log.buffer.Write(data)
}

func (log *torLog) tail(lines int) string {
	log.mu.Lock()
	defer log.mu.Unlock()
	all := strings.Split(strings.TrimSpace(log.buffer.String()), "\n")
	return strings.Join(all[max(0, len(all)-lines):], "\n")
}

// phoneTor is a client Tor standing in for the in-process Tor of the phone
// apps: SOCKS and control on loopback, cookie authentication.
type phoneTor struct {
	socks, control, cookie string
	log                    *torLog
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func startPhoneTor(t *testing.T, executable string) *phoneTor {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "phone-tor")
	data := filepath.Join(dir, "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	client := &phoneTor{
		socks:   fmt.Sprintf("127.0.0.1:%d", freeLoopbackPort(t)),
		control: fmt.Sprintf("127.0.0.1:%d", freeLoopbackPort(t)),
		cookie:  filepath.Join(data, "control_auth_cookie"),
		log:     &torLog{},
	}
	lines := []string{
		fmt.Sprintf("DataDirectory %q", data),
		"SocksPort " + client.socks,
		"ControlPort " + client.control,
		"CookieAuthentication 1",
		fmt.Sprintf("CookieAuthFile %q", client.cookie),
		fmt.Sprintf("__OwningControllerProcess %d", os.Getpid()),
		"Log notice stdout",
	}
	bundle := filepath.Dir(filepath.Dir(executable))
	for name, file := range map[string]string{"GeoIPFile": "geoip", "GeoIPv6File": "geoip6"} {
		if path := filepath.Join(bundle, "data", file); fileExists(path) {
			lines = append(lines, fmt.Sprintf("%s %q", name, path))
		}
	}
	torrc := filepath.Join(dir, "torrc")
	defaults := filepath.Join(dir, "torrc-defaults")
	if err := os.WriteFile(torrc, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(defaults, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-f", torrc, "--defaults-torrc", defaults)
	command.Dir = filepath.Dir(executable)
	command.Stdout, command.Stderr = client.log, client.log
	command.WaitDelay = 2 * time.Second
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
		if t.Failed() {
			t.Logf("phone tor log:\n%s", client.log.tail(40))
		}
	})
	return client
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// TestTunnelReachesDesktopThroughRealTor pairs and connects through two real
// Tor processes: one as the phone client, reached through SOCKS and control,
// and one hosting the onion service of the desktop. The QR carries a dead
// direct candidate, so pairing waits for the onion to be published, and the
// direct listener is closed before Connect, so the fallback carries the page.
func TestTunnelReachesDesktopThroughRealTor(t *testing.T) {
	executable := os.Getenv(realTorEnv)
	if executable == "" || testing.Short() {
		t.Skip(realTorEnv + " is not set")
	}
	ctx := testContext(t, 9*time.Minute)
	began := time.Now()
	clock := func() time.Duration { return time.Since(began).Round(100 * time.Millisecond) }

	client := startPhoneTor(t, executable)
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "desktop"))
	if err != nil {
		t.Fatal(err)
	}
	serviceLog := &torLog{}
	service, err := tor.StartDesktop(tor.DesktopConfig{Executable: executable, Dir: paths.Tor, OnionKeyPath: paths.OnionKey, Output: serviceLog})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = service.Close()
		if t.Failed() {
			t.Logf("desktop tor log:\n%s", serviceLog.tail(40))
		}
	})
	var published atomic.Int64
	go func() {
		if _, err := service.WaitState(ctx, func(state tor.State) bool { return state.Published }); err == nil {
			published.Store(int64(clock()))
		}
	}()
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{OnionListener: service.Listener(), Onion: service.Address() + ":443"})

	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	if err := tunnel.SetTorEndpoints(client.socks, client.control, client.cookie); err != nil {
		t.Fatal(err)
	}
	dead, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	unreachable := dead.LocalAddr().String()
	_ = dead.Close()
	payload := desktop.BeginPair(t, []pairing.Candidate{{Type: pairing.CandidateLAN, Address: unreachable}}, 10*time.Minute)

	pairStarted := time.Now()
	paired := pairWith(t, tunnel, payload)
	pairElapsed := time.Since(pairStarted)
	if paired.Transport != "tor" {
		t.Fatalf("pair %+v", paired)
	}
	if states := pairStates(events, 0); strings.Join(states, ",") != "lan,tor,confirming,completed" {
		t.Fatalf("pair events %v", states)
	}
	torEvents := events.kinds(0, "tor")
	t.Logf("paired over tor at %s after %s; tor events %v", clock(), pairElapsed.Round(time.Millisecond), torEvents)

	if err := desktop.StopDirect(); err != nil {
		t.Fatal(err)
	}
	var connected pathmgr.Result
	for attempt := 1; ; attempt++ {
		raw, err := tunnel.Connect(paired.DesktopID)
		if err == nil {
			connected = decode[pathmgr.Result](t, raw)
			break
		}
		t.Logf("connect attempt %d at %s: %v", attempt, clock(), err)
		if attempt == 4 || ctx.Err() != nil {
			t.Fatalf("connect over the fallback never succeeded: %v", err)
		}
	}
	if connected.Transport != "tor" || connected.Path != pathmgr.KindTor {
		t.Fatalf("connect %+v", connected)
	}
	t.Logf("connected over tor at %s in %d ms", clock(), connected.ElapsedMillis)

	page := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, paired.Token, 0)))
	loadStarted := time.Now()
	if code, body := page.get(t, "/"); code != 200 || !strings.Contains(body, "Cialai mobile") {
		t.Fatalf("page over tor: HTTP %d %q", code, body)
	}
	loadElapsed := time.Since(loadStarted)
	echoStarted := time.Now()
	page.echo(t, ctx, "over the real onion").CloseNow()
	echoElapsed := time.Since(echoStarted)
	if upgrade := lastUpgrade(t, desktop); upgrade.Transport != "tor" || upgrade.DeviceKey != tunnel.local.PublicKeyString() {
		t.Fatalf("bridge saw %+v", upgrade)
	}
	status := decode[map[string]any](t, must(tunnel.StatusJSON()))
	if fallback, _ := status["tor"].(map[string]any); fallback["state"] != pathmgr.TorReady {
		t.Fatalf("status %v", status)
	}
	t.Logf("timings: pair %s, connect %d ms, page load %s, WebSocket open and echo %s, onion published at %s, total %s",
		pairElapsed.Round(time.Millisecond), connected.ElapsedMillis, loadElapsed.Round(time.Millisecond), echoElapsed.Round(time.Millisecond), time.Duration(published.Load()), clock())
}
