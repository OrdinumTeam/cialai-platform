// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

func TestBrotoRegistryLifecycle(t *testing.T) {
	clock := testNow
	paths := testPaths(t)
	registry, err := OpenRegistry(paths, testDesktopIdentity(), func() time.Time { return clock }, nil)
	if err != nil {
		t.Fatal(err)
	}
	input := testDeviceInput(44)
	input.Kind = identity.RoleBroto
	device, token, err := registry.Pair(input)
	if err != nil {
		t.Fatal(err)
	}
	if device.Kind != identity.RoleBroto || !strings.HasPrefix(device.ID, "bro_") || !strings.HasPrefix(token, "cbt1.") {
		t.Fatal("incorrect Broto identity")
	}
	registry, err = OpenRegistry(paths, testDesktopIdentity(), func() time.Time { return clock }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := registry.Authenticate(token); !ok || got.Kind != identity.RoleBroto {
		t.Fatal("Broto token rejected")
	}
	if _, ok := registry.Authenticate(strings.Replace(token, "cbt1.", "cdt1.", 1)); ok {
		t.Fatal("cross-role token accepted")
	}
	next, err := registry.RotateToken(device.ID)
	if err != nil || !strings.HasPrefix(next, "cbt1.") {
		t.Fatal("rotation lost role", err)
	}
	if _, ok := registry.Authenticate(token); !ok {
		t.Fatal("previous token rejected during grace")
	}
	clock = clock.Add(PreviousTokenWindow)
	if _, ok := registry.Authenticate(token); ok {
		t.Fatal("expired token accepted")
	}
	if _, _, err := registry.Pair(testDeviceInput(44)); err == nil {
		t.Fatal("same key accepted under another role")
	}
	if err := registry.Revoke(device.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Authenticate(next); ok {
		t.Fatal("revoked token accepted")
	}
}

func TestRegistryMigratesV2PhoneAndRejectsUnknownKind(t *testing.T) {
	paths := testPaths(t)
	registry, err := OpenRegistry(paths, testDesktopIdentity(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := registry.Pair(testDeviceInput(45))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(paths.Devices)
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	file["version"] = float64(2)
	record := file["devices"].([]any)[0].(map[string]any)
	delete(record, "kind")
	write := func() {
		t.Helper()
		raw, err := json.Marshal(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(paths.Devices, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	migrated, err := OpenRegistry(paths, testDesktopIdentity(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := migrated.Authenticate(token); !ok || got.Kind != identity.RolePhone {
		t.Fatal("legacy phone lost")
	}
	broto := testDeviceInput(46)
	broto.Kind = identity.RoleBroto
	if _, _, err := migrated.Pair(broto); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRegistry(paths, testDesktopIdentity(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.Authenticate(token); !ok || got.Kind != identity.RolePhone {
		t.Fatal("legacy phone lost after saving and reopening migrated registry")
	}
	file["version"] = float64(RegistryVersion)
	record["kind"] = "admin"
	write()
	if _, err := OpenRegistry(paths, testDesktopIdentity(), nil, nil); err == nil {
		t.Fatal("unknown role accepted")
	}
}

func TestBrotoRenamePersistsWithoutChangingApprovalOrder(t *testing.T) {
	paths := testPaths(t)
	registry, err := OpenRegistry(paths, testDesktopIdentity(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	input := testDeviceInput(77)
	input.Kind = identity.RoleBroto
	original, _, err := registry.Pair(input)
	if err != nil {
		t.Fatal(err)
	}
	if err = registry.Rename(original.ID, "Build Linux"); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRegistry(paths, testDesktopIdentity(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := reopened.Get(original.ID)
	if !ok || got.Name != "Build Linux" || !got.PairedAt.Equal(original.PairedAt) || got.Level != original.Level {
		t.Fatal("rename changed pairing metadata")
	}
	if err = reopened.Rename(original.ID, "\ninvalid"); err == nil {
		t.Fatal("invalid device name accepted")
	}
}
