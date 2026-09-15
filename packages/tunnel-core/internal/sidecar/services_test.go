// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

func TestNetStartWithoutTorIsReadyAndIdempotent(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	status := h.start(t, map[string]any{"stun": []string{}})
	if status.State != netReady || status.Direct.State != "listening" || status.Edge.State != "running" {
		t.Fatalf("net.start without Tor is not ready: %+v", status)
	}
	if status.Tor.State != torDisabled || !strings.HasSuffix(status.Tor.Onion, ".onion") || status.Tor.Published {
		t.Fatalf("Tor without --tor-bin must be disabled with the persisted onion: %+v", status.Tor)
	}
	if status.MDNS.State != "disabled" || status.Direct.STUN.State != "disabled" || status.Direct.Mapping.Protocol != "none" {
		t.Fatalf("optional parts: %+v", status)
	}
	if status.Desktop == nil || !strings.HasPrefix(status.Desktop.ID, "d_") || status.Desktop.Name != "MacBook de Teste" {
		t.Fatalf("desktop identity: %+v", status.Desktop)
	}
	public, err := identity.ParsePublicKey(status.Desktop.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if derived, _ := identity.DeriveID(identity.RoleDesktop, public); derived != status.Desktop.ID || identity.Fingerprint(public) != status.Desktop.Fingerprint {
		t.Fatalf("desktop id %s does not derive from its key", status.Desktop.ID)
	}
	keyInfo, err := os.Stat(filepath.Join(h.paths.Root, identity.KeyFileName))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("identity.key mode %o", keyInfo.Mode().Perm())
	}
	var record identity.Record
	raw, err := os.ReadFile(filepath.Join(h.paths.Root, identity.RecordFileName))
	if err != nil || json.Unmarshal(raw, &record) != nil || record.Version != 2 || record.ID != status.Desktop.ID {
		t.Fatalf("identity.json v2: %s %v", raw, err)
	}

	again := h.start(t, map[string]any{"desktopName": "Mac renomeado", "requireApproval": true})
	if again.Direct.Port != status.Direct.Port || again.Desktop.ID != status.Desktop.ID || again.Desktop.Name != "Mac renomeado" {
		t.Fatalf("second net.start restarted or ignored the name: %+v then %+v", status, again)
	}
	h.waitEvent(t, "net.state", 0, testTimeout, func(data json.RawMessage) bool {
		var event NetStatus
		return json.Unmarshal(data, &event) == nil && event.State == netReady && event.Desktop != nil && event.Desktop.Name == "Mac renomeado"
	})

	var stopped map[string]string
	h.call(t, "net.stop", map[string]any{}, &stopped)
	if stopped["state"] != netStopped {
		t.Fatalf("net.stop: %v", stopped)
	}
	var after NetStatus
	h.call(t, "net.status", map[string]any{}, &after)
	if after.State != netStopped || after.Direct.State != "stopped" || after.Edge.State != "stopped" {
		t.Fatalf("status after net.stop: %+v", after)
	}
	var torState TorStatus
	h.call(t, "tor.status", map[string]any{}, &torState)
	if torState.State != torDisabled {
		t.Fatalf("tor.status after stop: %+v", torState)
	}
	restarted := h.start(t, nil)
	if restarted.State != netReady || restarted.Desktop.ID != status.Desktop.ID || restarted.Tor.Onion != status.Tor.Onion {
		t.Fatalf("restart changed the identity or the onion: %+v", restarted)
	}
}

func TestNetStartValidatesArguments(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	for name, args := range map[string]map[string]any{
		"empty name":     {"desktopName": ""},
		"long name":      {"desktopName": strings.Repeat("a", 49)},
		"control name":   {"desktopName": "Mac\nbook"},
		"stun not list":  {"stun": "stun.example:3478"},
		"missing static": {"staticDir": ""},
		"unknown field":  {"controlUrl": "https://hs.example"},
	} {
		base := map[string]any{"desktopName": "Mac", "staticDir": t.TempDir(), "bridgeUrl": "http://127.0.0.1:1", "proxySecret": "x"}
		for key, value := range args {
			base[key] = value
		}
		response := h.request("net.start", base, testTimeout)
		if response.OK || response.Error.Code != "args_invalid" {
			t.Fatalf("%s: %+v", name, response)
		}
	}
	response := h.request("net.start", map[string]any{"desktopName": "Mac", "staticDir": filepath.Join(t.TempDir(), "missing"), "bridgeUrl": "http://127.0.0.1:1", "proxySecret": "x"}, testTimeout)
	if response.OK || response.Error.Code != "edge_failed" {
		t.Fatalf("missing static directory: %+v", response)
	}
	var status NetStatus
	h.call(t, "net.status", map[string]any{}, &status)
	if status.State != netFailed || status.Error == nil || status.Error.Code != "edge_failed" {
		t.Fatalf("failed start must be reported: %+v", status)
	}
}

func TestPairBeginNeedsTheDirectListenerAndCarriesTheOnion(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	response := h.request("pair.begin", map[string]any{}, testTimeout)
	if response.OK || response.Error.Code != "net_not_ready" || !response.Error.Retryable {
		t.Fatalf("pair.begin before net.start: %+v", response)
	}
	status := h.start(t, nil)
	var begun struct {
		PairID             string    `json:"pairId"`
		Payload            string    `json:"payload"`
		ExpiresAt          int64     `json:"expiresAt"`
		RotateAfterSeconds int       `json:"rotateAfterSeconds"`
		Reserve            TorStatus `json:"reserve"`
	}
	h.call(t, "pair.begin", map[string]any{}, &begun)
	payload, err := pairing.Decode(begun.Payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(begun.Payload, pairing.Prefix))
	if len(raw) >= pairing.MaxJSONBytes {
		t.Fatalf("payload JSON has %d bytes", len(raw))
	}
	if payload.PairID != begun.PairID || payload.Onion != status.Tor.Onion+":443" || payload.Desktop.ID != status.Desktop.ID || payload.Desktop.PublicKey != status.Desktop.PublicKey {
		t.Fatalf("payload does not describe the desktop: %+v", payload)
	}
	if until := time.Until(time.Unix(begun.ExpiresAt, 0)); until < 590*time.Second || until > 601*time.Second {
		t.Fatalf("default validity: %s", until)
	}
	if begun.RotateAfterSeconds != 90 || begun.Reserve.State != torDisabled || begun.Reserve.Onion != status.Tor.Onion {
		t.Fatalf("pair.begin extras: %+v", begun)
	}
	if strings.Contains(h.log.tail(500), begun.Payload) {
		t.Fatal("the QR payload reached the log")
	}
	h.call(t, "pair.cancel", map[string]any{"pairId": begun.PairID}, nil)
	for _, ttl := range []int{0, 601} {
		if response := h.request("pair.begin", map[string]any{"ttlSeconds": ttl}, testTimeout); response.OK || response.Error.Code != "args_invalid" {
			t.Fatalf("ttl %d: %+v", ttl, response)
		}
	}
	if response := h.request("pair.approve", map[string]any{"pairId": begun.PairID}, testTimeout); response.OK || response.Error.Code != "pair_unknown" {
		t.Fatalf("approve without pending pairing: %+v", response)
	}
}

func TestFakeTorBootstrapsPublishesAndClosesWithShutdown(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan *fakeTor, 1)
	h := startHarness(t, harnessOptions{
		torExecutable: executable,
		startTor: func(config tor.DesktopConfig) (TorService, error) {
			if config.Executable != executable || config.Dir == "" || config.OnionKeyPath == "" || config.OnState == nil {
				t.Errorf("tor config: %+v", config)
			}
			fake, err := startFakeTor(config)
			if err == nil {
				started <- fake
			}
			return fake, err
		},
	})
	status := h.start(t, nil)
	fake := <-started
	if status.State != netReady || status.Tor.State != torStarting || status.Tor.Onion != fake.Address() {
		t.Fatalf("Tor starting must not hold the network: %+v", status)
	}
	fake.set(func(state *tor.State) {
		state.Phase = tor.PhaseBootstrapping
		state.Bootstrap = tor.Bootstrap{Progress: 37}
	})
	h.waitEvent(t, "tor.state", 0, testTimeout, func(data json.RawMessage) bool {
		var event TorStatus
		return json.Unmarshal(data, &event) == nil && event.State == torBootstrapping && event.Progress == 37
	})
	fake.set(func(state *tor.State) {
		state.Phase = tor.PhasePublished
		state.Bootstrap = tor.Bootstrap{Progress: 100}
		state.Published = true
	})
	h.waitEvent(t, "net.state", 0, testTimeout, func(data json.RawMessage) bool {
		var event NetStatus
		return json.Unmarshal(data, &event) == nil && event.State == netReady && event.Tor.Published && event.Tor.State == torReady
	})
	var diagnostics Diagnostics
	h.call(t, "diagnostics.run", map[string]any{}, &diagnostics)
	ids := make([]string, 0, len(diagnostics.Checks))
	for _, check := range diagnostics.Checks {
		ids = append(ids, check.ID)
	}
	want := []string{"identity", "direct_listener", "lan_candidates", "ipv6", "port_mapping", "stun", "tor_process", "tor_bootstrap", "onion_published", "mdns", "edge"}
	if !slices.Equal(ids, want) || !diagnostics.OK {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}

	fake.set(func(state *tor.State) {
		state.Phase = tor.PhaseFailed
		state.Published = false
		state.Err = errors.New("tor exited")
	})
	h.waitEvent(t, "net.state", 0, testTimeout, func(data json.RawMessage) bool {
		var event NetStatus
		return json.Unmarshal(data, &event) == nil && event.State == netDegraded && event.Tor.State == torFailed
	})
	h.shutdown(t)
	if !fake.isClosed() {
		t.Fatal("shutdown did not close Tor")
	}
	last := h.eventsNamed("net.state")
	var final NetStatus
	if err := json.Unmarshal(last[len(last)-1], &final); err != nil || final.State != netStopped {
		t.Fatalf("last net.state before exit: %s", last[len(last)-1])
	}
}

func TestTorStartFailureDegradesWithoutStoppingTheDirectPath(t *testing.T) {
	h := startHarness(t, harnessOptions{torExecutable: filepath.Join(t.TempDir(), "missing-tor")})
	status := h.start(t, nil)
	if status.State != netDegraded || status.Direct.State != "listening" || status.Tor.State != torFailed || status.Tor.Error != "tor_unavailable" {
		t.Fatalf("missing Tor: %+v", status)
	}
	h.call(t, "pair.begin", map[string]any{"ttlSeconds": 60}, nil)
	disabled := h.start(t, nil)
	if disabled.Tor.State != torFailed {
		t.Fatalf("idempotent start changed Tor: %+v", disabled)
	}
	h.call(t, "net.stop", map[string]any{}, nil)
	status = h.start(t, map[string]any{"tor": false})
	if status.State != netReady || status.Tor.State != torDisabled {
		t.Fatalf("tor false: %+v", status)
	}
}

func TestAnnouncerSeamFollowsRefreshAndStop(t *testing.T) {
	announcer := &fakeAnnouncer{}
	var created []AnnouncerConfig
	var mu sync.Mutex
	h := startHarness(t, harnessOptions{announcer: func(config AnnouncerConfig) (Announcer, error) {
		mu.Lock()
		created = append(created, config)
		mu.Unlock()
		return announcer, nil
	}})
	status := h.start(t, nil)
	if status.MDNS.State != "announcing" {
		t.Fatalf("mdns state: %+v", status.MDNS)
	}
	mu.Lock()
	first := created[0]
	mu.Unlock()
	if identity.EncodePublicKey(first.PublicKey) != status.Desktop.PublicKey || int(first.Port) != status.Direct.Port || first.Logf == nil {
		t.Fatalf("announcer config: %+v for %+v", first, status)
	}
	h.start(t, map[string]any{"desktopName": "Outro nome"})
	h.call(t, "net.refresh", map[string]any{}, nil)
	h.call(t, "net.stop", map[string]any{}, nil)
	refreshes, closed := announcer.snapshot()
	if refreshes != 1 || !closed {
		t.Fatalf("announcer refreshes %d closed %v", refreshes, closed)
	}

	failing := startHarness(t, harnessOptions{announcer: func(AnnouncerConfig) (Announcer, error) {
		return nil, errors.New("mdns: no usable interface")
	}})
	if status := failing.start(t, nil); status.MDNS.State != "failed" || status.State != netDegraded {
		t.Fatalf("failed announcer: %+v", status)
	}
}

func TestDeviceCommandsUseTheV2Registry(t *testing.T) {
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// A phone paired in an earlier run: same identity key, same registry.
	desktop, record, _, err := identity.Open(identity.Options{Role: identity.RoleDesktop, Dir: paths.Root, Name: "MacBook"})
	if err != nil {
		t.Fatal(err)
	}
	registry, err := pairing.OpenRegistry(paths, pairing.DesktopIdentity{ID: desktop.ID(), Name: "MacBook", CreatedAt: record.CreatedAt}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	device, _, err := registry.Pair(pairing.DeviceInput{
		Name: "iPhone", Model: "iPhone16,1", Platform: "ios", App: "1.0.0",
		DeviceKey: phone.PublicKeyString(), Transport: pairing.TransportDirect, RemoteAddr: "192.168.1.20:50000",
	})
	if err != nil {
		t.Fatal(err)
	}

	h := startHarness(t, harnessOptions{paths: &paths})
	var empty struct {
		Devices []DeviceView `json:"devices"`
	}
	h.call(t, "devices.list", map[string]any{}, &empty)
	if empty.Devices == nil || len(empty.Devices) != 0 {
		t.Fatalf("devices before net.start: %+v", empty)
	}
	if status := h.start(t, nil); status.Desktop.ID != desktop.ID() {
		t.Fatalf("net.start created another identity: %+v", status.Desktop)
	}
	var listed struct {
		Devices []DeviceView `json:"devices"`
	}
	h.call(t, "devices.list", map[string]any{}, &listed)
	if len(listed.Devices) != 1 {
		t.Fatalf("devices.list: %+v", listed)
	}
	view := listed.Devices[0]
	if view.ID != device.ID || view.Fingerprint != phone.Fingerprint() || view.DeviceKey != phone.PublicKeyString() || view.Connected || view.Transports == nil || view.LastTransport != "direct" {
		t.Fatalf("device view: %+v", view)
	}
	raw, _ := json.Marshal(view)
	if strings.Contains(strings.ToLower(string(raw)), "hash") {
		t.Fatalf("device view exposes token data: %s", raw)
	}
	var renamed DeviceView
	h.call(t, "devices.rename", map[string]any{"deviceId": device.ID, "name": "iPhone novo"}, &renamed)
	if renamed.Name != "iPhone novo" || renamed.ID != device.ID {
		t.Fatalf("rename: %+v", renamed)
	}
	h.call(t, "devices.rotateToken", map[string]any{"deviceId": device.ID}, nil)
	var revoked map[string]int
	h.call(t, "devices.revoke", map[string]any{"deviceId": device.ID}, &revoked)
	if _, ok := revoked["sessions"]; !ok {
		t.Fatalf("revoke result: %v", revoked)
	}
	if _, ok := revoked["sockets"]; !ok {
		t.Fatalf("revoke result: %v", revoked)
	}
	if response := h.request("devices.revoke", map[string]any{"deviceId": "dev_missing"}, testTimeout); response.OK || response.Error.Code != "device_not_found" {
		t.Fatalf("unknown device: %+v", response)
	}
	h.waitEvent(t, "devices.changed", 0, testTimeout, func(data json.RawMessage) bool {
		var event map[string]any
		return json.Unmarshal(data, &event) == nil && event["deviceId"] == device.ID && event["name"] == "iPhone novo"
	})
	h.waitEvent(t, "devices.changed", 0, testTimeout, func(data json.RawMessage) bool {
		var event map[string]any
		return json.Unmarshal(data, &event) == nil && event["deviceId"] == device.ID && event["revoked"] == true
	})
	revocations := 0
	for _, data := range h.eventsNamed("devices.changed") {
		if strings.Contains(string(data), `"revoked":true`) {
			revocations++
		}
	}
	if revocations != 1 {
		t.Fatalf("devices.revoke emitted devices.changed %d times", revocations)
	}
}

func TestLegacyRegistryIsMovedAside(t *testing.T) {
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"version":1,"desktop":{"id":"d_AAAAAAAAAAAAAAAAAAAAAA","name":"MacBook"},"devices":[]}` + "\n")
	if err := os.WriteFile(paths.Devices, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	h := startHarness(t, harnessOptions{paths: &paths})
	if status := h.start(t, nil); status.State != netReady {
		t.Fatalf("legacy registry blocked net.start: %+v", status)
	}
	kept, err := os.ReadFile(paths.Devices + legacyRegistrySuffix)
	if err != nil || !bytes.Equal(kept, legacy) {
		t.Fatalf("legacy registry not kept aside: %v", err)
	}
	var listed struct {
		Devices []DeviceView `json:"devices"`
	}
	h.call(t, "devices.list", map[string]any{}, &listed)
	if len(listed.Devices) != 0 {
		t.Fatalf("legacy devices migrated: %+v", listed)
	}
}

func TestStateEmitterCoalescesAndSkipsRepeats(t *testing.T) {
	var mu sync.Mutex
	value := 0
	var sent []time.Time
	emitter := newStateEmitter(100*time.Millisecond, func() NetStatus {
		mu.Lock()
		defer mu.Unlock()
		status := stoppedStatus()
		status.Direct.Port = value
		return status
	}, func(NetStatus) {
		mu.Lock()
		sent = append(sent, time.Now())
		mu.Unlock()
	})
	for index := range 20 {
		mu.Lock()
		value = index
		mu.Unlock()
		emitter.trigger()
		time.Sleep(10 * time.Millisecond)
	}
	emitter.trigger()
	time.Sleep(250 * time.Millisecond)
	emitter.trigger()
	time.Sleep(150 * time.Millisecond)
	emitter.close()
	mu.Lock()
	defer mu.Unlock()
	if len(sent) < 2 || len(sent) > 4 {
		t.Fatalf("200 ms of changes produced %d events", len(sent))
	}
	for index := 1; index < len(sent); index++ {
		if gap := sent[index].Sub(sent[index-1]); gap < 90*time.Millisecond {
			t.Fatalf("events %s apart", gap)
		}
	}
}

func TestTorStatusMapsSupervisorPhases(t *testing.T) {
	onion := "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd.onion"
	for _, test := range []struct {
		state tor.State
		want  TorStatus
	}{
		{tor.State{Phase: tor.PhaseStarting, Address: onion}, TorStatus{State: torStarting, Onion: onion}},
		{tor.State{Phase: tor.PhaseBootstrapping, Address: onion, Bootstrap: tor.Bootstrap{Progress: 45}}, TorStatus{State: torBootstrapping, Progress: 45, Onion: onion}},
		{tor.State{Phase: tor.PhaseBootstrapping, Address: onion, Bootstrap: tor.Bootstrap{Progress: 100}}, TorStatus{State: torReady, Progress: 100, Onion: onion}},
		{tor.State{Phase: tor.PhasePublished, Address: onion, Bootstrap: tor.Bootstrap{Progress: 100}, Published: true}, TorStatus{State: torReady, Progress: 100, Onion: onion, Published: true}},
		{tor.State{Phase: tor.PhaseRestarting, Address: onion, Bootstrap: tor.Bootstrap{Progress: 80}}, TorStatus{State: torStarting, Onion: onion, Error: "tor_restarting"}},
		{tor.State{Phase: tor.PhaseFailed, Address: onion, Err: tor.ErrAddressMismatch}, TorStatus{State: torFailed, Onion: onion, Error: "tor_address_mismatch"}},
		{tor.State{Phase: tor.PhaseStopped, Address: onion}, TorStatus{State: torDisabled, Onion: onion}},
	} {
		if got := torStatus(test.state); got != test.want {
			t.Fatalf("%s: got %+v want %+v", test.state.Phase, got, test.want)
		}
	}
}

func TestNetStatusNamesCandidatesAndMapping(t *testing.T) {
	snapshot := candidates.Snapshot{Candidates: []candidates.Candidate{
		{Type: pairing.CandidateLAN, Address: netip.MustParseAddrPort("192.168.1.10:4740")},
		{Type: pairing.CandidateSTUN, Address: netip.MustParseAddrPort("203.0.113.9:4740")},
	}}
	list := directCandidates(snapshot)
	if len(list) != 2 || list[0].Kind != "lan" || list[1].Kind != "reflexive" || list[1].Addr != "203.0.113.9:4740" {
		t.Fatalf("candidates: %+v", list)
	}
	if stun := stunStatus(true, snapshot); stun.State != "ok" || stun.Addr != "203.0.113.9:4740" {
		t.Fatalf("stun: %+v", stun)
	}
	if stun := stunStatus(true, candidates.Snapshot{}); stun.State != "failed" {
		t.Fatalf("stun without answer: %+v", stun)
	}
	for protocol, want := range map[string]string{"pcp": "pcp", "pmp": "natpmp", "upnp": "upnp", "": "none"} {
		if got := mappingProtocol(protocol); got != want {
			t.Fatalf("mapping %q: %q", protocol, got)
		}
	}
}

func TestApprovalQueueEmitsCodeAndResolves(t *testing.T) {
	var mu sync.Mutex
	var events []map[string]any
	queue := newApprovalQueue(func(name string, data any) {
		if name != "pair.requested" {
			return
		}
		mu.Lock()
		events = append(events, data.(map[string]any))
		mu.Unlock()
	})
	if queue.resolve("p_missing", true) {
		t.Fatal("resolved an unknown pairing")
	}
	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, approved := range []bool{true, false} {
		result := make(chan error, 1)
		go func() {
			result <- queue.Await(context.Background(), edge.ApprovalRequest{
				PairID: "p_fixture", Transport: "direct", Until: time.Now().Add(time.Minute),
				Device: edge.PairDevice{Name: "iPhone", PublicKey: phone.PublicKeyString()},
			})
		}()
		deadline := time.Now().Add(testTimeout)
		for !queue.resolve("p_fixture", approved) {
			if time.Now().After(deadline) {
				t.Fatal("approval never became pending")
			}
			time.Sleep(5 * time.Millisecond)
		}
		err := <-result
		if approved && err != nil || !approved && pairing.Code(err) != "pair_denied" {
			t.Fatalf("approved %v returned %v", approved, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 2 || len(events[0]["code"].(string)) != 4 || events[0]["fingerprint"] != phone.Fingerprint() || events[0]["transport"] != "direct" {
		t.Fatalf("pair.requested: %+v", events)
	}
}
