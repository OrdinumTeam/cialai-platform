// SPDX-License-Identifier: Apache-2.0
package mobile

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
)

// fakeDesktop returns a desktop identity with its onion address.
func fakeDesktop(t *testing.T) (*identity.Identity, string) {
	t.Helper()
	local, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	key, err := tor.GenerateOnionKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return local, key.Address() + ":443"
}

func encodedPayload(t *testing.T, desktop *identity.Identity, onion string, expiresAt time.Time) string {
	t.Helper()
	encoded, err := pairing.Encode(pairing.Payload{
		Version:    pairing.PayloadVersion,
		Desktop:    pairing.Desktop{ID: desktop.ID(), Name: "Mac de Teste", PublicKey: desktop.PublicKeyString()},
		Onion:      onion,
		Candidates: []pairing.Candidate{{Type: pairing.CandidateLAN, Address: "192.168.15.23:4740"}},
		Secret:     base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		ExpiresAt:  expiresAt.Unix(),
		PairID:     "p_" + base64.RawURLEncoding.EncodeToString(make([]byte, 8)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func rememberDesktop(t *testing.T, tunnel *Tunnel, desktop *identity.Identity, onion string) storedDesktop {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	stored := storedDesktop{
		ID: desktop.ID(), Name: "Mac de Teste", PublicKey: desktop.PublicKeyString(), Fingerprint: desktop.Fingerprint(),
		Onion: onion, Candidates: []pairing.Candidate{{Type: pairing.CandidateLAN, Address: "192.168.15.23:4740"}},
		CandidatesIssuedAt: now, PairedAt: now, LastSeenAt: now, LastTransport: "direct",
	}
	tunnel.mu.Lock()
	tunnel.desktops[stored.ID] = stored
	tunnel.mu.Unlock()
	if err := tunnel.save(); err != nil {
		t.Fatal(err)
	}
	return stored
}

func TestVersionIdentityAndIdleStatus(t *testing.T) {
	if Version() != "0.2.0" {
		t.Fatalf("unexpected version %q", Version())
	}
	stateDir := filepath.Join(t.TempDir(), "state")
	tunnel := newTestTunnel(t, stateDir, nil)
	if !strings.HasPrefix(tunnel.local.ID(), "dev_") {
		t.Fatalf("phone identity id %q", tunnel.local.ID())
	}
	info, err := os.Stat(filepath.Join(stateDir, identity.KeyFileName))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("identity key %v, %v", info, err)
	}
	if info, err := os.Stat(stateDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("state directory %v, %v", info, err)
	}
	status, err := tunnel.StatusJSON()
	if err != nil || status != `{"state":"idle","tor":{"state":"disabled","progress":0},"desktops":0}` {
		t.Fatalf("idle status %s, %v", status, err)
	}
	desktops, err := tunnel.DesktopsJSON()
	if err != nil || desktops != `{"desktops":[]}` {
		t.Fatalf("desktops %s, %v", desktops, err)
	}
	again := newTestTunnel(t, stateDir, nil)
	if again.local.ID() != tunnel.local.ID() {
		t.Fatal("the phone identity changed across restarts")
	}
}

func TestLegacyStateIsDiscardedOnce(t *testing.T) {
	stateDir := t.TempDir()
	legacy := `{"version":1,"profiles":[{"id":"profile_x","controlUrl":"https://hs.example.com","userId":"42","userName":"foco","hostname":"cialai-pixel","desktops":{}}]}`
	if err := os.WriteFile(filepath.Join(stateDir, mobileStateFile), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	tsnet := filepath.Join(stateDir, "profiles", "profile_x", "tsnet")
	if err := os.MkdirAll(tsnet, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tsnet, "tailscaled.state"), []byte("node private key"), 0o600); err != nil {
		t.Fatal(err)
	}
	first := &recorder{}
	newTestTunnel(t, stateDir, first)
	states := first.kinds(0, "state")
	if len(states) != 1 || states[0]["legacyDiscarded"] != true {
		t.Fatalf("state events %v, want legacyDiscarded once", states)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "profiles")); !os.IsNotExist(err) {
		t.Fatalf("the tsnet state of version 1 survived: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, mobileStateFile))
	if err != nil || !strings.Contains(string(raw), `"version": 2`) {
		t.Fatalf("state after discard %s, %v", raw, err)
	}
	second := &recorder{}
	newTestTunnel(t, stateDir, second)
	if events := second.kinds(0, "state"); len(events) != 0 {
		t.Fatalf("legacy discard reported again: %v", events)
	}
}

func TestCorruptOrFutureStateIsRefused(t *testing.T) {
	for _, content := range []string{`{`, `{"version":3,"desktops":{}}`, `{"version":2,"desktops":{"d_x":{"id":"d_x"}}}`, `{"version":2,"desktops":{},"token":"cdt1.x"}`} {
		stateDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(stateDir, mobileStateFile), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := NewTunnel(stateDir, nil); errorCode(err) != "state_invalid" {
			t.Fatalf("state %s opened with %v", content, err)
		}
	}
	if _, err := NewTunnel("relative/state", nil); errorCode(err) != "state_invalid" {
		t.Fatalf("relative state directory opened with %v", err)
	}
}

func TestStateRoundTripsTheReachCard(t *testing.T) {
	stateDir := t.TempDir()
	tunnel := newTestTunnel(t, stateDir, nil)
	desktop, onion := fakeDesktop(t)
	stored := rememberDesktop(t, tunnel, desktop, onion)
	reopened := newTestTunnel(t, stateDir, nil)
	loaded, ok := reopened.desktops[stored.ID]
	if !ok || loaded.Onion != onion || len(loaded.Candidates) != 1 || !loaded.CandidatesIssuedAt.Equal(stored.CandidatesIssuedAt) {
		t.Fatalf("reloaded desktop %+v", loaded)
	}
	card, err := loaded.card()
	if err != nil || card.Desktop.PublicKey != desktop.PublicKeyString() || !card.ExpiresAt.Equal(stored.CandidatesIssuedAt.Add(24*time.Hour)) {
		t.Fatalf("card %+v, %v", card, err)
	}
	listed := decode[struct {
		Desktops []map[string]any `json:"desktops"`
	}](t, must(reopened.DesktopsJSON()))
	if len(listed.Desktops) != 1 || listed.Desktops[0]["id"] != stored.ID || listed.Desktops[0]["fingerprint"] != desktop.Fingerprint() || listed.Desktops[0]["lastTransport"] != "direct" {
		t.Fatalf("desktops %v", listed)
	}
	if len(listed.Desktops[0]) != 6 {
		t.Fatalf("desktops expose more than the contract: %v", listed.Desktops[0])
	}
	if err := reopened.ForgetDesktop(stored.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Connect(stored.ID); errorCode(err) != "desktop_unknown" {
		t.Fatalf("connect after forget: %v", err)
	}
	if err := reopened.ForgetDesktop(stored.ID); err != nil {
		t.Fatalf("forgetting twice: %v", err)
	}
}

func must(value string, err error) string {
	if err != nil {
		panic(err)
	}
	return value
}

func TestInspectPairPayloadOmitsSecretsAndKnowsPairedDesktops(t *testing.T) {
	tunnel := newTestTunnel(t, t.TempDir(), nil)
	desktop, onion := fakeDesktop(t)
	payload := encodedPayload(t, desktop, onion, time.Now().Add(10*time.Minute))
	inspected, err := tunnel.InspectPairPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(inspected, "p_AAAA") || strings.Contains(inspected, base64.RawURLEncoding.EncodeToString(make([]byte, 32))) || strings.Contains(inspected, ".onion") {
		t.Fatalf("inspection leaked QR data: %s", inspected)
	}
	view := decode[map[string]any](t, inspected)
	desktopView := view["desktop"].(map[string]any)
	if view["v"] != float64(2) || view["known"] != false || view["candidates"] != float64(1) || desktopView["id"] != desktop.ID() || desktopView["fingerprint"] != desktop.Fingerprint() || desktopView["name"] != "Mac de Teste" {
		t.Fatalf("inspection %s", inspected)
	}
	decoded, err := pairing.Decode(payload)
	if err != nil {
		t.Fatal(err)
	}
	if view["approvalCode"] != pairing.ApprovalCode(decoded.PairID, tunnel.local.PublicKey()) {
		t.Fatalf("approval code %v does not match the desktop derivation", view["approvalCode"])
	}
	rememberDesktop(t, tunnel, desktop, onion)
	if view := decode[map[string]any](t, must(tunnel.InspectPairPayload(payload))); view["known"] != true {
		t.Fatalf("paired desktop not known: %v", view)
	}
	for _, bad := range []string{"CIALAI1.abc", "hello", ""} {
		if _, err := tunnel.InspectPairPayload(bad); errorCode(err) == "" {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := tunnel.InspectPairPayload(encodedPayload(t, desktop, onion, time.Now().Add(-2*time.Minute))); errorCode(err) != "payload_expired" {
		t.Fatalf("expired payload: %v", err)
	}
}

func TestPairRefusesInvalidDeviceAndExpiredPayloadBeforeDialing(t *testing.T) {
	tunnel := newTestTunnel(t, t.TempDir(), nil)
	desktop, onion := fakeDesktop(t)
	valid := encodedPayload(t, desktop, onion, time.Now().Add(10*time.Minute))
	for _, device := range [][4]string{
		{"", "Pixel 9", "android", "1.0.0"},
		{"Pixel", "Pixel 9", "windows", "1.0.0"},
		{"Pixel", "", "android", "1.0.0"},
		{strings.Repeat("a", 49), "Pixel 9", "android", "1.0.0"},
	} {
		if _, err := tunnel.Pair(valid, device[0], device[1], device[2], device[3]); errorCode(err) != "device_invalid" {
			t.Fatalf("device %v: %v", device, err)
		}
	}
	expired := encodedPayload(t, desktop, onion, time.Now().Add(-2*time.Minute))
	if _, err := tunnel.Pair(expired, "Pixel", "Pixel 9", "android", "1.0.0"); errorCode(err) != "payload_expired" {
		t.Fatalf("expired payload: %v", err)
	}
	tunnel.mu.Lock()
	endpoint := tunnel.endpoint
	tunnel.mu.Unlock()
	if endpoint != nil {
		t.Fatal("a refused pairing opened a socket")
	}
}

func TestCallsForUnknownDesktopsAreCoded(t *testing.T) {
	tunnel := newTestTunnel(t, t.TempDir(), nil)
	if _, err := tunnel.Connect("d_AAAAAAAAAAAAAAAAAAAAAA"); errorCode(err) != "desktop_unknown" {
		t.Fatalf("connect: %v", err)
	}
	if _, err := tunnel.OpenDesktop("d_AAAAAAAAAAAAAAAAAAAAAA", "cdt1.dev_x.y", 0); errorCode(err) != "desktop_unknown" {
		t.Fatalf("open: %v", err)
	}
	if err := tunnel.CloseDesktop("d_AAAAAAAAAAAAAAAAAAAAAA"); err != nil {
		t.Fatalf("closing a desktop that is not open: %v", err)
	}
	tunnel.NotifyNetworkChange(false)
	tunnel.NotifyForeground(true)
}

func TestReportLanCandidatesIsValidated(t *testing.T) {
	tunnel := newTestTunnel(t, t.TempDir(), nil)
	desktop, onion := fakeDesktop(t)
	report := `[{"host":"192.168.15.40","port":4740,"id":"` + desktop.ID() + `","fp":"` + desktop.Fingerprint() + `"}]`
	if err := tunnel.ReportLanCandidates(desktop.ID(), report); errorCode(err) != "desktop_unknown" {
		t.Fatalf("report for an unknown desktop: %v", err)
	}
	rememberDesktop(t, tunnel, desktop, onion)
	for _, bad := range []string{`{}`, `[{"host":"192.168.15.40","port":4740,"id":"` + desktop.ID() + `","fp":"0000000000000000"}]`, `[{"host":"example.com","port":4740,"id":"` + desktop.ID() + `","fp":"` + desktop.Fingerprint() + `"}]`} {
		if err := tunnel.ReportLanCandidates(desktop.ID(), bad); errorCode(err) != "lan_report_invalid" {
			t.Fatalf("report %s: %v", bad, err)
		}
	}
	if err := tunnel.ReportLanCandidates(desktop.ID(), report); err != nil {
		t.Fatal(err)
	}
	tunnel.mu.Lock()
	reported := tunnel.reported[desktop.ID()]
	tunnel.mu.Unlock()
	if len(reported) != 1 || reported[0].String() != "192.168.15.40:4740" {
		t.Fatalf("reported %v", reported)
	}
}

func TestSetTorEndpointsReportsTheFallbackState(t *testing.T) {
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	if err := tunnel.SetTorEndpoints("", "127.0.0.1:9051", ""); errorCode(err) != "tor_endpoints_invalid" {
		t.Fatalf("control without SOCKS: %v", err)
	}
	if err := tunnel.SetTorEndpoints("198.51.100.7:9050", "", ""); errorCode(err) != "tor_endpoints_invalid" {
		t.Fatalf("non loopback SOCKS: %v", err)
	}
	if err := tunnel.SetTorEndpoints("127.0.0.1:9050", "127.0.0.1:9051", "/data/tor/control_auth_cookie"); err != nil {
		t.Fatal(err)
	}
	if err := tunnel.SetTorEndpoints("", "", ""); err != nil {
		t.Fatal(err)
	}
	tor := events.kinds(0, "tor")
	if len(tor) != 2 || tor[0]["state"] != pathmgr.TorUnknown || tor[1]["state"] != pathmgr.TorDisabled {
		t.Fatalf("tor events %v", tor)
	}
}

func TestSetLogLevelFiltersLogEvents(t *testing.T) {
	events := &recorder{}
	tunnel := newTestTunnel(t, t.TempDir(), events)
	tunnel.log(levelDebug, "hidden")
	tunnel.SetLogLevel("debug")
	tunnel.log(levelDebug, "shown")
	tunnel.SetLogLevel("verbose")
	tunnel.log(levelDebug, "still shown")
	tunnel.SetLogLevel("error")
	tunnel.log(levelInfo, "hidden again")
	logs := events.kinds(0, "log")
	if len(logs) != 2 || logs[0]["message"] != "shown" || logs[1]["level"] != "debug" {
		t.Fatalf("log events %v", logs)
	}
}

func TestPrepareQUICDisablesECNOnlyOnAndroid(t *testing.T) {
	if err := prepareQUIC("ios", func(string, string) error {
		t.Fatal("iOS must not set the Android ECN workaround")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var name, value string
	if err := prepareQUIC("android", func(gotName, gotValue string) error {
		name, value = gotName, gotValue
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if name != quicDisableECNEnvironment || value != "true" {
		t.Fatalf("Android workaround not prepared: %q=%q", name, value)
	}
}

func TestPairTimingsFollowTheContract(t *testing.T) {
	if pairDirectBudget != 3*time.Second || pairTorRetry != 5*time.Second {
		t.Fatalf("pairing budgets %s and %s", pairDirectBudget, pairTorRetry)
	}
}
