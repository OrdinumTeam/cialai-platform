// SPDX-License-Identifier: Apache-2.0
package mobile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/testutil"
)

// These tests pair and connect mobile.Tunnel with an in-process v2 desktop
// built by testutil.StartDesktop from the packages the sidecar composes. The
// direct path is QUIC on loopback; the fallback goes through the real
// tor.Client and a SOCKS5 stand-in that routes the onion name to the onion
// TLS listener of the desktop.

type pairOutput struct {
	DesktopID string `json:"desktopId"`
	DeviceID  string `json:"deviceId"`
	Token     string `json:"token"`
	Desktop   struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Fingerprint string `json:"fingerprint"`
	} `json:"desktop"`
	Transport string `json:"transport"`
}

func pairWith(t *testing.T, tunnel *Tunnel, payload string) pairOutput {
	t.Helper()
	raw, err := tunnel.Pair(payload, "Pixel de Teste", "Pixel 9", "android", "1.0.0")
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	return decode[pairOutput](t, raw)
}

func connectTo(t *testing.T, tunnel *Tunnel, desktopID string) pathmgr.Result {
	t.Helper()
	raw, err := tunnel.Connect(desktopID)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return decode[pathmgr.Result](t, raw)
}

func lastUpgrade(t *testing.T, desktop *testutil.Desktop) testutil.BridgeHeaders {
	t.Helper()
	upgrades := desktop.Bridge.Upgrades()
	if len(upgrades) == 0 {
		t.Fatal("the bridge saw no upgrade")
	}
	return upgrades[len(upgrades)-1]
}

func pairStates(events *recorder, mark int) []string {
	var states []string
	for _, payload := range events.kinds(mark, "pair") {
		states = append(states, payload["state"].(string))
	}
	return states
}

func TestTunnelPairsConnectsAndOpensAgainstV2Desktop(t *testing.T) {
	ctx := testContext(t, 2*time.Minute)
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	stateDir := filepath.Join(t.TempDir(), "phone")
	events := &recorder{}
	tunnel := newTestTunnel(t, stateDir, events)

	payload := desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute)
	inspection := decode[map[string]any](t, must(tunnel.InspectPairPayload(payload)))
	inspected := inspection["desktop"].(map[string]any)
	if inspection["known"] != false || inspected["id"] != desktop.Identity.ID() || inspected["fingerprint"] != desktop.Identity.Fingerprint() {
		t.Fatalf("inspection %v", inspection)
	}

	started := time.Now()
	paired := pairWith(t, tunnel, payload)
	pairElapsed := time.Since(started)
	if paired.Transport != "direct" || paired.DesktopID != desktop.Identity.ID() || paired.DeviceID != tunnel.local.ID() ||
		!strings.HasPrefix(paired.Token, "cdt1."+paired.DeviceID+".") || paired.Desktop.Fingerprint != desktop.Identity.Fingerprint() || paired.Desktop.Name != "Mac de Teste" {
		t.Fatalf("pair output %+v", paired)
	}
	if states := pairStates(events, 0); strings.Join(states, ",") != "lan,confirming,completed" {
		t.Fatalf("pair events %v", states)
	}
	device, found := desktop.Registry.Get(paired.DeviceID)
	if !found || device.DeviceKey != tunnel.local.PublicKeyString() || device.LastTransport != "direct" {
		t.Fatalf("desktop registered %+v", device)
	}
	if view := decode[map[string]any](t, must(tunnel.InspectPairPayload(payload))); view["known"] != true {
		t.Fatalf("paired desktop is not known: %v", view)
	}

	started = time.Now()
	connected := connectTo(t, tunnel, paired.DesktopID)
	connectElapsed := time.Since(started)
	if connected.Transport != "direct" || connected.Path != pathmgr.KindLAN || connected.DesktopID != paired.DesktopID {
		t.Fatalf("connect %+v", connected)
	}
	status := decode[map[string]any](t, must(tunnel.StatusJSON()))
	active, _ := status["active"].(map[string]any)
	if status["state"] != "connected" || active["path"] != "lan" || active["transport"] != "direct" || status["desktops"] != float64(1) {
		t.Fatalf("status %v", status)
	}

	opened := must(tunnel.OpenDesktop(paired.DesktopID, paired.Token, 0))
	page := openPage(t, opened)
	if code, body := page.get(t, "/"); code != http.StatusOK || !strings.Contains(body, "Cialai mobile") {
		t.Fatalf("desktop page through the proxy: HTTP %d %q", code, body)
	}
	started = time.Now()
	socket := page.echo(t, ctx, `{"type":"pty_write","data":"ls\n"}`)
	echoElapsed := time.Since(started)
	upgrade := lastUpgrade(t, desktop)
	if upgrade.DeviceID != paired.DeviceID || upgrade.DeviceKey != tunnel.local.PublicKeyString() || upgrade.Transport != "direct" ||
		upgrade.ProxySecret != testutil.DesktopProxySecret || upgrade.Authorization != "" || upgrade.Cookie != "" {
		t.Fatalf("bridge saw %+v", upgrade)
	}
	socket.CloseNow()
	requireNoToken(t, stateDir, paired.Token)
	// The running tunnel may be replacing the file; statedir.ReadFile waits
	// out the sharing violation Windows reports meanwhile.
	if raw, err := statedir.ReadFile(filepath.Join(stateDir, mobileStateFile)); err != nil || !strings.Contains(string(raw), desktop.Onion) {
		t.Fatalf("reach card not stored: %s, %v", raw, err)
	}
	if err := tunnel.Stop(); err != nil {
		t.Fatal(err)
	}
	if status := decode[map[string]any](t, must(tunnel.StatusJSON())); status["state"] != "idle" {
		t.Fatalf("status after stop %v", status)
	}

	// The app restarts: same identity, remembered card, stored token, no QR.
	restartEvents := &recorder{}
	restarted := newTestTunnel(t, stateDir, restartEvents)
	for _, state := range restartEvents.kinds(0, "state") {
		if state["legacyDiscarded"] != nil {
			t.Fatal("a version 2 state was reported as legacy")
		}
	}
	listed := decode[struct {
		Desktops []map[string]any `json:"desktops"`
	}](t, must(restarted.DesktopsJSON()))
	if len(listed.Desktops) != 1 || listed.Desktops[0]["id"] != paired.DesktopID || listed.Desktops[0]["lastTransport"] != "direct" {
		t.Fatalf("desktops after restart %v", listed)
	}
	started = time.Now()
	reconnected := connectTo(t, restarted, paired.DesktopID)
	reconnectElapsed := time.Since(started)
	if reconnected.Transport != "direct" || reconnected.Path != pathmgr.KindLAN {
		t.Fatalf("reconnect %+v", reconnected)
	}
	page = openPage(t, must(restarted.OpenDesktop(paired.DesktopID, paired.Token, 0)))
	page.echo(t, ctx, "again").CloseNow()
	if upgrade := lastUpgrade(t, desktop); upgrade.DeviceKey != tunnel.local.PublicKeyString() || upgrade.DeviceID != paired.DeviceID {
		t.Fatalf("bridge saw %+v after restart", upgrade)
	}
	if paths := restartEvents.kinds(0, "path"); len(paths) == 0 || paths[0]["path"] != "lan" || paths[0]["reason"] != pathmgr.ReasonConnect {
		t.Fatalf("path events after restart %v", paths)
	}
	t.Logf("pair %s, connect %s (manager %d ms), first echo %s, reconnect after restart %s (manager %d ms)",
		pairElapsed.Round(time.Millisecond), connectElapsed.Round(time.Millisecond), connected.ElapsedMillis,
		echoElapsed.Round(time.Millisecond), reconnectElapsed.Round(time.Millisecond), reconnected.ElapsedMillis)
}

// TestTunnelSwitchesToReserveAndRotatesTokenOverQUICAndTor covers the path
// change of CON-028 end to end and CON-064: with the desktop clock moved
// forward, the edge rotates the token over QUIC and over the TLS of the
// fallback, the proxy hands it to native through proxy token-rotated, and the
// previous token keeps working for 24 hours.
func TestTunnelSwitchesToReserveAndRotatesTokenOverQUICAndTor(t *testing.T) {
	ctx := testContext(t, 3*time.Minute)
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	socks := testutil.StartSOCKS(t)
	socks.Route(desktop.OnionHost(), desktop.OnionTarget())
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	if err := tunnel.SetTorEndpoints(socks.Addr(), "", ""); err != nil {
		t.Fatal(err)
	}
	paired := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))
	tokenA := paired.Token
	if connected := connectTo(t, tunnel, paired.DesktopID); connected.Path != pathmgr.KindLAN {
		t.Fatalf("connect %+v", connected)
	}
	page := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, tokenA, 0)))
	page.echo(t, ctx, "fresh token").CloseNow()
	if rotated := events.kinds(0, "proxy"); len(rotated) != 1 || rotated[0]["state"] != "open" {
		t.Fatalf("proxy events before rotation %v", rotated)
	}

	// Rotation over QUIC.
	desktop.Clock.Advance(pairing.TokenRotationInterval + time.Minute)
	mark := events.mark()
	page.echo(t, ctx, "rotation over quic").CloseNow()
	rotatedB := events.wait(t, mark, "proxy", field("state", "token-rotated"))
	tokenB, _ := rotatedB["deviceToken"].(string)
	if rotatedB["desktopId"] != paired.DesktopID || tokenB == "" || tokenB == tokenA {
		t.Fatalf("token-rotated %v", rotatedB)
	}
	if upgrade := lastUpgrade(t, desktop); upgrade.Transport != "direct" {
		t.Fatalf("rotation upgrade arrived over %q", upgrade.Transport)
	}
	if _, ok := desktop.Registry.Authenticate(tokenB); !ok {
		t.Fatal("the desktop does not accept the rotated token")
	}
	page.echo(t, ctx, "proxy adopted the new token").CloseNow()
	if len(events.kinds(mark, "proxy")) != 1 {
		t.Fatalf("token rotated more than once: %v", events.kinds(mark, "proxy"))
	}
	// The native side still holding token A keeps working within 24 hours.
	oldPage := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, tokenA, 0)))
	oldPage.echo(t, ctx, "previous token within 24 h").CloseNow()

	// The direct path goes down with a socket open: the proxy closes it and
	// the page reconnects over the fallback.
	page = openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, tokenB, 0)))
	open := page.echo(t, ctx, "before the path change")
	messages := desktop.Bridge.Messages()
	mark = events.mark()
	downAt := time.Now()
	if err := desktop.StopDirect(); err != nil {
		t.Fatal(err)
	}
	switched := events.wait(t, mark, "path", field("path", "tor"))
	switchElapsed := time.Since(downAt)
	if switched["transport"] != "tor" || switched["reason"] != pathmgr.ReasonPathFailed || switched["desktopId"] != paired.DesktopID {
		t.Fatalf("path event %v", switched)
	}
	readContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, _, err := open.Read(readContext)
	cancel()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the socket of the direct path stayed open: %v", err)
	}
	open.CloseNow()
	page.echo(t, ctx, "after the path change").CloseNow()
	if upgrade := lastUpgrade(t, desktop); upgrade.Transport != "tor" {
		t.Fatalf("reconnected socket arrived over %q", upgrade.Transport)
	}
	if got := desktop.Bridge.Messages(); got != messages+1 {
		t.Fatalf("bridge read %d messages across the path change, want %d: a message was repeated", got, messages+1)
	}
	if socks.Dials() == 0 {
		t.Fatal("the fallback did not dial through SOCKS")
	}
	status := decode[map[string]any](t, must(tunnel.StatusJSON()))
	if active, _ := status["active"].(map[string]any); active["path"] != "tor" {
		t.Fatalf("status after the switch %v", status)
	}

	// Rotation over the TLS of the fallback.
	desktop.Clock.Advance(pairing.TokenRotationInterval + time.Minute)
	mark = events.mark()
	page.echo(t, ctx, "rotation over tor").CloseNow()
	rotatedC := events.wait(t, mark, "proxy", field("state", "token-rotated"))
	tokenC, _ := rotatedC["deviceToken"].(string)
	if tokenC == "" || tokenC == tokenB || tokenC == tokenA {
		t.Fatalf("token-rotated over tor %v", rotatedC)
	}
	if upgrade := lastUpgrade(t, desktop); upgrade.Transport != "tor" {
		t.Fatalf("rotation upgrade arrived over %q", upgrade.Transport)
	}
	previousPage := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, tokenB, 0)))
	previousPage.echo(t, ctx, "token B within 24 h").CloseNow()

	// After 24 hours only the latest token opens a socket.
	desktop.Clock.Advance(pairing.PreviousTokenWindow + time.Minute)
	if socket, response, err := previousPage.dial(ctx); err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		if socket != nil {
			socket.CloseNow()
		}
		t.Fatalf("token B after 24 h: %v, %v", response, err)
	}
	latest := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, tokenC, 0)))
	latest.echo(t, ctx, "token C").CloseNow()
	t.Logf("direct to tor switch observed %s after the desktop endpoint closed; socks dials %d", switchElapsed.Round(time.Millisecond), socks.Dials())
}

func TestTunnelPairsOverTheReserveUntilTheOnionAnswers(t *testing.T) {
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	socks := testutil.StartSOCKS(t)
	socks.Route(desktop.OnionHost(), desktop.OnionTarget())
	socks.SetRefuse(true)
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	tunnel.pairRetry = time.Second
	if err := tunnel.SetTorEndpoints(socks.Addr(), "", ""); err != nil {
		t.Fatal(err)
	}
	dead, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	unreachable := dead.LocalAddr().String()
	_ = dead.Close()
	payload := desktop.BeginPair(t, []pairing.Candidate{{Type: pairing.CandidateLAN, Address: unreachable}}, 2*time.Minute)
	go func() {
		for socks.Refused() < 2 {
			time.Sleep(20 * time.Millisecond)
		}
		socks.SetRefuse(false)
	}()
	started := time.Now()
	paired := pairWith(t, tunnel, payload)
	elapsed := time.Since(started)
	if paired.Transport != "tor" || socks.Refused() < 2 || socks.Dials() < 3 {
		t.Fatalf("pair %+v with %d refused of %d onion dials", paired, socks.Refused(), socks.Dials())
	}
	if states := pairStates(events, 0); strings.Join(states, ",") != "lan,tor,confirming,completed" {
		t.Fatalf("pair events %v", states)
	}
	if device, _ := desktop.Registry.Get(paired.DeviceID); device.LastTransport != "tor" {
		t.Fatalf("desktop recorded %+v", device)
	}
	// The reach card returned by the pairing carries the real candidate.
	if connected := connectTo(t, tunnel, paired.DesktopID); connected.Path != pathmgr.KindLAN {
		t.Fatalf("connect with the stored reach card %+v", connected)
	}
	t.Logf("pairing over the fallback took %s with %d refused onion dials", elapsed.Round(time.Millisecond), socks.Refused())
}

func TestTunnelWithoutTorOrDirectPathReportsReserveUnavailable(t *testing.T) {
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	tunnel.pairTorGrace = time.Second
	tunnel.pairRetry = 200 * time.Millisecond
	tunnel.timings = pathmgr.Timings{Retries: []time.Duration{}}
	dead, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	unreachable := dead.LocalAddr().String()
	_ = dead.Close()
	payload := desktop.BeginPair(t, []pairing.Candidate{{Type: pairing.CandidateLAN, Address: unreachable}}, 2*time.Minute)
	if _, err := tunnel.Pair(payload, "Pixel", "Pixel 9", "android", "1.0.0"); errorCode(err) != pathmgr.CodeReserveUnavailable {
		t.Fatalf("pair without Tor: %v", err)
	}

	paired := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))
	connectTo(t, tunnel, paired.DesktopID)
	mark := events.mark()
	if err := desktop.StopDirect(); err != nil {
		t.Fatal(err)
	}
	offline := events.wait(t, mark, "state", field("state", "offline"))
	if offline["desktopId"] != paired.DesktopID || offline["code"] != pathmgr.CodeReserveUnavailable {
		t.Fatalf("offline state %v", offline)
	}
	if path := events.wait(t, mark, "path", field("path", "none")); path["reason"] != pathmgr.CodeReserveUnavailable {
		t.Fatalf("path event %v", path)
	}
	if _, err := tunnel.Connect(paired.DesktopID); errorCode(err) != pathmgr.CodeReserveUnavailable {
		t.Fatalf("connect without a path: %v", err)
	}
}

func TestTunnelRevocationClosesTheSocketWith4401AndEndsThePath(t *testing.T) {
	ctx := testContext(t, 2*time.Minute)
	desktop := testutil.StartDesktop(t, testutil.DesktopOptions{})
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	paired := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))
	connectTo(t, tunnel, paired.DesktopID)
	page := openPage(t, must(tunnel.OpenDesktop(paired.DesktopID, paired.Token, 0)))
	socket := page.echo(t, ctx, "before revocation")
	defer socket.CloseNow()

	mark := events.mark()
	result, err := desktop.Revoke(paired.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = socket.Read(ctx)
	if websocket.CloseStatus(err) != 4401 {
		t.Fatalf("page saw %v, want the 4401 close", err)
	}
	if revoked := events.wait(t, mark, "proxy", field("state", "revoked")); revoked["desktopId"] != paired.DesktopID {
		t.Fatalf("proxy revoked event %v", revoked)
	}
	if path := events.wait(t, mark, "path", field("reason", pathmgr.CodeRevoked)); path["path"] != "none" {
		t.Fatalf("path event %v", path)
	}
	offline := events.wait(t, mark, "state", field("code", pathmgr.CodeRevoked))
	if offline["state"] != "offline" || offline["desktopId"] != paired.DesktopID {
		t.Fatalf("state event %v", offline)
	}
	if _, err := tunnel.Connect(paired.DesktopID); errorCode(err) != pathmgr.CodeRevoked {
		t.Fatalf("connect after revocation: %v", err)
	}
	t.Logf("revocation closed %d sessions and %d leftover sockets", result.Sessions, result.Sockets)

	// Pairing again replaces the revoked manager.
	again := pairWith(t, tunnel, desktop.BeginPair(t, []pairing.Candidate{desktop.LANCandidate()}, 10*time.Minute))
	if again.DeviceID != paired.DeviceID {
		t.Fatalf("pairing again changed the device id: %s", again.DeviceID)
	}
	if connected := connectTo(t, tunnel, again.DesktopID); connected.Transport != "direct" {
		t.Fatalf("connect after pairing again %+v", connected)
	}
	openPage(t, must(tunnel.OpenDesktop(again.DesktopID, again.Token, 0))).echo(t, ctx, "paired again").CloseNow()
	if _, ok := desktop.Registry.Authenticate(paired.Token); ok {
		t.Fatal("the token of the revoked pairing still authenticates")
	}
}

// TestOpenDesktopReusesTheProxyOfTheSameDesktop is CONN-04 with CONN-02 and
// CONN-11 end to end: opening the same desktop again returns the same URL,
// port and nonce, keeps the socket the page holds and lets a page load once
// more; the local health route answers without the cookie; and a page loaded
// again with its cookie is sent to the bridge. Another desktop gets a proxy
// of its own and the previous socket ends.
func TestOpenDesktopReusesTheProxyOfTheSameDesktop(t *testing.T) {
	ctx := testContext(t, 2*time.Minute)
	first := testutil.StartDesktop(t, testutil.DesktopOptions{Name: "Mac do estúdio"})
	second := testutil.StartDesktop(t, testutil.DesktopOptions{Name: "Mac da sala"})
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	pairedA := pairWith(t, tunnel, first.BeginPair(t, []pairing.Candidate{first.LANCandidate()}, 10*time.Minute))
	pairedB := pairWith(t, tunnel, second.BeginPair(t, []pairing.Candidate{second.LANCandidate()}, 10*time.Minute))

	// Before the desktop is open the health route is not served at all.
	connectTo(t, tunnel, pairedA.DesktopID)
	openedA := decode[proxy.OpenResult](t, must(tunnel.OpenDesktop(pairedA.DesktopID, pairedA.Token, 0)))
	page := openPage(t, must(tunnel.OpenDesktop(pairedA.DesktopID, pairedA.Token, 0)))
	socket := page.echo(t, ctx, "before opening again")
	defer socket.CloseNow()

	again := decode[proxy.OpenResult](t, must(tunnel.OpenDesktop(pairedA.DesktopID, pairedA.Token, 0)))
	if again.URL != openedA.URL || again.Port != openedA.Port || again.Nonce != openedA.Nonce {
		t.Fatalf("opening the same desktop again returned %+v, want %+v", again, openedA)
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte("after opening again")); err != nil {
		t.Fatal(err)
	}
	if _, data, err := socket.Read(ctx); err != nil || string(data) != "after opening again" {
		t.Fatalf("the socket did not survive the second opening: %q, %v", data, err)
	}
	// The same opening bootstraps a page loaded anew, with the same cookie.
	fresh := openPage(t, must(tunnel.OpenDesktop(pairedA.DesktopID, pairedA.Token, 0)))
	if fresh.cookie != page.cookie {
		t.Fatalf("cookie changed across openings: %q then %q", page.cookie, fresh.cookie)
	}
	fresh.echo(t, ctx, "fresh page over the reused proxy").CloseNow()
	opens := 0
	for _, event := range events.kinds(0, "proxy") {
		if event["state"] == "open" {
			opens++
		}
	}
	if opens != 1 {
		t.Fatalf("proxy opened %d times for the same desktop: %v", opens, events.kinds(0, "proxy"))
	}

	// The health route answers the shell without the cookie and never
	// reaches the desktop bridge.
	health, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", openedA.Port, proxy.HealthPath))
	if err != nil {
		t.Fatal(err)
	}
	healthBody := decode[map[string]string](t, readAll(t, health))
	if health.StatusCode != http.StatusOK || healthBody["status"] != "ok" || healthBody["service"] != "cialai" || healthBody["transport"] != "direct" {
		t.Fatalf("health: HTTP %d %v", health.StatusCode, healthBody)
	}
	// A page loaded again with its cookie is sent to the bridge location.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	reload, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", openedA.Port), nil)
	if err != nil {
		t.Fatal(err)
	}
	reload.Header.Set("Cookie", page.cookie)
	redirected, err := client.Do(reload)
	if err != nil {
		t.Fatal(err)
	}
	_ = redirected.Body.Close()
	if redirected.StatusCode != http.StatusFound || redirected.Header.Get("Location") != proxy.BridgeLocation(openedA.Port) {
		t.Fatalf("second load of the page root: HTTP %d Location %q", redirected.StatusCode, redirected.Header.Get("Location"))
	}
	if code, body := page.get(t, "/"); code != http.StatusOK || !strings.Contains(body, "Cialai mobile") {
		t.Fatalf("page after the redirect: HTTP %d %q", code, body)
	}

	// Another desktop replaces the proxy and ends the previous socket.
	mark := events.mark()
	connectTo(t, tunnel, pairedB.DesktopID)
	openedB := decode[proxy.OpenResult](t, must(tunnel.OpenDesktop(pairedB.DesktopID, pairedB.Token, 0)))
	if openedB.Nonce == openedA.Nonce || openedB.URL == openedA.URL {
		t.Fatalf("the second desktop reused the opening of the first: %+v", openedB)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, _, err = socket.Read(readCtx)
	cancel()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the socket of the first desktop stayed open: %v", err)
	}
	if closed := events.wait(t, mark, "proxy", field("state", "closed")); closed["desktopId"] != pairedA.DesktopID {
		t.Fatalf("proxy closed event %v", closed)
	}
	if opened := events.wait(t, mark, "proxy", field("state", "open")); opened["desktopId"] != pairedB.DesktopID {
		t.Fatalf("proxy open event %v", opened)
	}
	openPage(t, must(tunnel.OpenDesktop(pairedB.DesktopID, pairedB.Token, 0))).echo(t, ctx, "second desktop").CloseNow()
	if upgrade := lastUpgrade(t, second); upgrade.DeviceID != pairedB.DeviceID {
		t.Fatalf("second desktop saw %+v", upgrade)
	}
}

func readAll(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
