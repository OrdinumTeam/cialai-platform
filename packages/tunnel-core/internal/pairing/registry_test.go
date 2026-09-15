// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

func testPaths(t *testing.T) statedir.Paths {
	t.Helper()
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "tunnel"))
	if err != nil {
		t.Fatal(err)
	}
	return paths
}

func testDesktopIdentity() DesktopIdentity {
	return DesktopIdentity{ID: testDesktop("MacBook de Foco").ID, Name: "MacBook de Foco", CreatedAt: testNow}
}

func testDeviceInput(fill byte) DeviceInput {
	return DeviceInput{
		Name: "iPhone de Foco", Model: "iPhone16,1", Platform: "ios", App: "1.0.0",
		DeviceKey: identity.EncodePublicKey(testPublicKey(fill)), Transport: TransportDirect, RemoteAddr: "192.168.15.40:51234",
	}
}

func TestRegistryPairsByDeviceKeyAndRecordsTheLastTransport(t *testing.T) {
	clock := testNow
	paths := testPaths(t)
	registry, err := OpenRegistry(paths, testDesktopIdentity(), func() time.Time { return clock }, bytes.NewReader(testEntropy(2048)))
	if err != nil {
		t.Fatal(err)
	}
	input := testDeviceInput(0x44)
	expectedID, _ := identity.DeriveID(identity.RolePhone, testPublicKey(0x44))
	device, token, err := registry.Pair(input)
	if err != nil || device.ID != expectedID || !strings.HasPrefix(device.ID, "dev_") || !strings.HasPrefix(token, "cdt1."+device.ID+".") {
		t.Fatalf("pair failed: %#v %v", device, err)
	}
	if device.DeviceKey != input.DeviceKey || device.LastTransport != TransportDirect || device.LastRemoteAddr != input.RemoteAddr || !device.PairedAt.Equal(testNow) {
		t.Fatalf("paired device lost its key or transport: %#v", device)
	}
	if id, ok := registry.RegisteredKey(input.DeviceKey); !ok || id != device.ID {
		t.Fatalf("registered key not found: %q %v", id, ok)
	}
	for _, unknown := range []string{"", identity.EncodePublicKey(testPublicKey(0x45)), input.DeviceKey + "="} {
		if _, ok := registry.RegisteredKey(unknown); ok {
			t.Fatalf("unregistered key %q was accepted", unknown)
		}
	}
	if got, ok := registry.Authenticate(token); !ok || got.ID != device.ID {
		t.Fatal("fresh token was not accepted")
	}

	raw, err := os.ReadFile(paths.Devices)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil || stored["version"] != float64(RegistryVersion) {
		t.Fatalf("registry is not version 2: %v", err)
	}
	for _, field := range []string{`"deviceKey": "` + input.DeviceKey + `"`, `"lastTransport": "direct"`, `"lastRemoteAddr": "192.168.15.40:51234"`, `"sha256:`} {
		if !bytes.Contains(raw, []byte(field)) {
			t.Fatalf("registry lacks %s", field)
		}
	}
	if bytes.Contains(raw, []byte(token)) || bytes.Contains(raw, []byte(token[strings.LastIndex(token, ".")+1:])) {
		t.Fatal("registry stored the plaintext token")
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(paths.Devices); info.Mode().Perm() != 0o600 {
			t.Fatalf("registry mode is %o", info.Mode().Perm())
		}
	}

	clock = testNow.Add(time.Hour)
	if err := registry.MarkSeen(device.ID, TransportTor, ""); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][2]string{{"quic", ""}, {"", ""}, {TransportDirect, "192.168.15.40"}, {TransportDirect, "a\n:1"}} {
		if err := registry.MarkSeen(device.ID, invalid[0], invalid[1]); err == nil {
			t.Fatalf("invalid last transport %q %q accepted", invalid[0], invalid[1])
		}
	}
	if err := registry.MarkSeen("dev_unknown", TransportTor, ""); err == nil {
		t.Fatal("unknown device was marked as seen")
	}
	reopened, err := OpenRegistry(paths, testDesktopIdentity(), func() time.Time { return clock }, nil)
	if err != nil {
		t.Fatal(err)
	}
	seen, ok := reopened.Get(device.ID)
	if !ok || seen.LastTransport != TransportTor || seen.LastRemoteAddr != "" || !seen.LastSeenAt.Equal(clock) {
		t.Fatalf("last transport was not persisted: %#v", seen)
	}
	if id, ok := reopened.RegisteredKey(input.DeviceKey); !ok || id != device.ID {
		t.Fatal("reopened registry lost the device key")
	}

	if reopened.RevokedKey(input.DeviceKey) {
		t.Fatal("an active device key is reported revoked")
	}
	if err := reopened.Revoke(device.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.RegisteredKey(input.DeviceKey); ok {
		t.Fatal("revoked device key is still registered")
	}
	if !reopened.RevokedKey(input.DeviceKey) || reopened.RevokedKey(identity.EncodePublicKey(testPublicKey(0x45))) {
		t.Fatal("the transports cannot tell a revoked key from an unknown one")
	}
	revokedAt := clock
	clock = clock.Add(time.Minute)
	if err := reopened.Revoke(device.ID); err != nil {
		t.Fatal(err)
	}
	if revoked, _ := reopened.Get(device.ID); !revoked.Revoked || revoked.RevokedAt == nil || !revoked.RevokedAt.Equal(revokedAt) {
		t.Fatalf("revoking again moved the retention start: %#v", revoked)
	}
	if err := reopened.Revoke("dev_unknown"); err == nil {
		t.Fatal("revoked an unknown device")
	}
	if _, ok := reopened.Authenticate(token); ok {
		t.Fatal("revoked device token was accepted")
	}
	if err := reopened.MarkSeen(device.ID, TransportDirect, "192.168.15.40:51234"); err == nil {
		t.Fatal("revoked device was marked as seen")
	}

	clock = clock.Add(time.Minute)
	input.Transport, input.RemoteAddr = TransportTor, ""
	again, newToken, err := reopened.Pair(input)
	if err != nil || again.ID != device.ID || again.Revoked || !again.PairedAt.Equal(testNow) || again.LastTransport != TransportTor || newToken == token {
		t.Fatalf("pairing the same key again did not restore the device: %#v %v", again, err)
	}
	if _, ok := reopened.RegisteredKey(input.DeviceKey); !ok || reopened.RevokedKey(input.DeviceKey) {
		t.Fatal("paired again device key is not registered")
	}
	if _, ok := reopened.Authenticate(token); ok {
		t.Fatal("pairing again left the previous token active")
	}
	if devices := reopened.List(); len(devices) != 1 {
		t.Fatalf("pairing the same key again duplicated the device: %d", len(devices))
	}
}

func TestRegistryHonorsTokenWindowsAndRevokedRetention(t *testing.T) {
	clock := testNow
	registry, err := OpenRegistry(testPaths(t), testDesktopIdentity(), func() time.Time { return clock }, bytes.NewReader(testEntropy(2048)))
	if err != nil {
		t.Fatal(err)
	}
	device, token, err := registry.Pair(testDeviceInput(0x44))
	if err != nil {
		t.Fatal(err)
	}
	if registry.TokenRotationDue(device.ID) {
		t.Fatal("fresh token is already due")
	}
	clock = testNow.Add(TokenRotationInterval)
	if !registry.TokenRotationDue(device.ID) {
		t.Fatal("30-day token rotation was not requested")
	}
	rotated, err := registry.RotateToken(device.ID)
	if err != nil || rotated == token {
		t.Fatal("token rotation failed")
	}
	if _, ok := registry.Authenticate(token); !ok {
		t.Fatal("previous token was not accepted in the grace window")
	}
	clock = clock.Add(PreviousTokenWindow + time.Second)
	if _, ok := registry.Authenticate(token); ok {
		t.Fatal("previous token survived the grace window")
	}
	if _, ok := registry.Authenticate(rotated); !ok {
		t.Fatal("rotated token was not accepted")
	}
	if err := registry.RequestTokenRotation(device.ID); err != nil || !registry.TokenRotationDue(device.ID) {
		t.Fatalf("requested rotation is not due: %v", err)
	}
	if err := registry.Rename(device.ID, "Telefone pessoal"); err != nil {
		t.Fatal(err)
	}
	if err := registry.Rename(device.ID, ""); err == nil {
		t.Fatal("empty device name accepted")
	}
	if err := registry.Revoke(device.ID); err != nil {
		t.Fatal(err)
	}
	visible, _ := json.Marshal(registry.List())
	if bytes.Contains(visible, []byte("tokenHash")) || !bytes.Contains(visible, []byte("Telefone pessoal")) {
		t.Fatalf("unsafe or wrong public list: %s", visible)
	}
	if removed, err := registry.PruneRevoked(); err != nil || removed != 0 {
		t.Fatalf("recently revoked device was pruned: %d %v", removed, err)
	}
	clock = clock.Add(RevokedRetention + time.Second)
	if removed, err := registry.PruneRevoked(); err != nil || removed != 1 || len(registry.List()) != 0 {
		t.Fatalf("revoked retention failed: %d %v", removed, err)
	}
}

func TestRegistryRefusesTheLegacyV1File(t *testing.T) {
	paths := testPaths(t)
	legacyDesktop := pairingv1.DesktopIdentity{ID: testDesktopIdentity().ID, Name: "MacBook de Foco", CreatedAt: testNow}
	legacy, err := pairingv1.OpenRegistry(paths, legacyDesktop, func() time.Time { return testNow }, bytes.NewReader(testEntropy(512)))
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = legacy.Pair(pairingv1.DeviceInput{
		Name: "iPhone de Foco", Model: "iPhone16,1", Platform: "ios", App: "1.0.0",
		NodeKey: "nodekey:" + strings.Repeat("b", 64), NodeID: "17", UserID: "42", IP4: "100.64.0.9", RemoteAddr: "100.64.0.9:51234",
	})
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(paths.Devices)
	if err != nil {
		t.Fatal(err)
	}

	registry, err := OpenRegistry(paths, testDesktopIdentity(), func() time.Time { return testNow }, bytes.NewReader(testEntropy(512)))
	if registry != nil || !errors.Is(err, ErrLegacyRegistry) || Code(err) != "registry_legacy" || !errors.Is(err, ErrPairing) {
		t.Fatalf("legacy registry was not refused explicitly: %v", err)
	}
	if !strings.Contains(err.Error(), "pareados de novo") {
		t.Fatalf("legacy refusal does not ask to pair again: %q", err.Error())
	}
	after, _ := os.ReadFile(paths.Devices)
	if !bytes.Equal(before, after) {
		t.Fatal("refusing the legacy registry changed the file")
	}
}

func TestRegistryRejectsInvalidInputAndCorruptState(t *testing.T) {
	paths := testPaths(t)
	desktop := testDesktopIdentity()
	for _, invalid := range []DesktopIdentity{{ID: "d_short", Name: "Mac", CreatedAt: testNow}, {ID: desktop.ID, Name: "", CreatedAt: testNow}, {ID: desktop.ID, Name: "Mac"}} {
		if _, err := OpenRegistry(paths, invalid, nil, nil); err == nil {
			t.Fatalf("invalid desktop identity accepted: %#v", invalid)
		}
	}
	registry, err := OpenRegistry(paths, desktop, func() time.Time { return testNow }, bytes.NewReader(testEntropy(2048)))
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*DeviceInput){
		"key-short":         func(input *DeviceInput) { input.DeviceKey = "short" },
		"key-padded":        func(input *DeviceInput) { input.DeviceKey += "=" },
		"transport-empty":   func(input *DeviceInput) { input.Transport = "" },
		"transport-unknown": func(input *DeviceInput) { input.Transport = "headscale" },
		"remote-no-port":    func(input *DeviceInput) { input.RemoteAddr = "192.168.15.40" },
		"name-empty":        func(input *DeviceInput) { input.Name = "" },
		"platform-invalid":  func(input *DeviceInput) { input.Platform = "iOS 18" },
	} {
		input := testDeviceInput(0x44)
		mutate(&input)
		if _, _, err := registry.Pair(input); err == nil {
			t.Fatalf("%s: invalid device accepted", name)
		}
	}
	if _, err := os.Stat(paths.Devices); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("refused devices were persisted")
	}
	if _, _, err := registry.Pair(testDeviceInput(0x44)); err != nil {
		t.Fatal(err)
	}
	valid, err := os.ReadFile(paths.Devices)
	if err != nil {
		t.Fatal(err)
	}
	otherKey := identity.EncodePublicKey(testPublicKey(0x45))
	replace := func(old, replacement string) []byte {
		if !bytes.Contains(valid, []byte(old)) {
			t.Fatalf("registry lacks %q", old)
		}
		return bytes.Replace(valid, []byte(old), []byte(replacement), 1)
	}
	for name, raw := range map[string][]byte{
		"version-3":          replace(`"version": 2`, `"version": 3`),
		"version-missing":    replace(`"version": 2,`, ``),
		"unknown-field":      replace(`"version": 2,`, `"version": 2, "headscale": true,`),
		"id-not-derived":     replace(`"deviceKey": "`+testDeviceInput(0x44).DeviceKey+`"`, `"deviceKey": "`+otherKey+`"`),
		"transport-invalid":  replace(`"lastTransport": "direct"`, `"lastTransport": "tailnet"`),
		"remote-invalid":     replace(`"lastRemoteAddr": "192.168.15.40:51234"`, `"lastRemoteAddr": "nowhere"`),
		"trailing-data":      append(append([]byte{}, valid...), []byte(`{}`)...),
		"not-json":           []byte(`version 2`),
		"exceeds-size-limit": append(bytes.Repeat([]byte(" "), maxRegistryBytes), valid...),
	} {
		if err := paths.WriteAtomic(paths.Devices, raw); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenRegistry(paths, desktop, nil, nil); err == nil || errors.Is(err, ErrLegacyRegistry) {
			t.Fatalf("%s: corrupt registry was not refused as corrupt: %v", name, err)
		}
	}
	if err := paths.WriteAtomic(paths.Devices, valid); err != nil {
		t.Fatal(err)
	}
	otherDesktop := DesktopIdentity{ID: "d_" + strings.Repeat("A", 22), Name: "Outro Mac", CreatedAt: testNow}
	if _, err := OpenRegistry(paths, otherDesktop, nil, nil); err == nil {
		t.Fatal("registry of another desktop was accepted")
	}
	if _, err := OpenRegistry(paths, desktop, nil, nil); err != nil {
		t.Fatalf("valid registry was refused: %v", err)
	}
}

func TestRegistryLookupsAreSafeWithConcurrentUpdates(t *testing.T) {
	registry, err := OpenRegistry(testPaths(t), testDesktopIdentity(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	device, token, err := registry.Pair(testDeviceInput(0x44))
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for index := range 8 {
		wait.Add(3)
		go func() {
			defer wait.Done()
			if id, ok := registry.RegisteredKey(device.DeviceKey); !ok || id != device.ID {
				t.Error("registered key lookup failed during updates")
			}
		}()
		go func() {
			defer wait.Done()
			transport := TransportDirect
			if index%2 == 1 {
				transport = TransportTor
			}
			if err := registry.MarkSeen(device.ID, transport, ""); err != nil {
				t.Error(err)
			}
		}()
		go func() {
			defer wait.Done()
			if _, ok := registry.Authenticate(token); !ok {
				t.Error("token lookup failed during updates")
			}
		}()
	}
	wait.Wait()
}
