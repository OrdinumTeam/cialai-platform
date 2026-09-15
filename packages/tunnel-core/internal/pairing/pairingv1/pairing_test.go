// SPDX-License-Identifier: Apache-2.0
package pairingv1

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

func validPayload(now time.Time) Payload {
	authKey := "hskey-auth-example"
	return Payload{
		Version:    1,
		ControlURL: "https://hs.example.com",
		UserID:     "42",
		UserName:   "foco",
		AuthKey:    &authKey,
		Desktop: Desktop{
			ID:      encodedID("d_", 16, 1),
			Name:    "MacBook de Foco",
			NodeKey: "nodekey:" + strings.Repeat("a", 64),
			IP4:     "100.64.0.3",
			Port:    4740,
		},
		Secret:    base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)),
		ExpiresAt: now.Add(10 * time.Minute).Unix(),
		PairID:    encodedID("p_", 8, 3),
	}
}

func encodedID(prefix string, size, value int) string {
	return prefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{byte(value)}, size))
}

func testEntropy(size int) []byte {
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index%251 + 1)
	}
	return data
}

func TestPayloadCodecIsStrictAndInspectionDoesNotExposeSecrets(t *testing.T) {
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	payload := validPayload(now)
	encoded, err := Encode(payload, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encoded, Prefix) || strings.Contains(encoded, "=") {
		t.Fatalf("unexpected QR framing: %q", encoded)
	}
	decoded, err := Decode(encoded, false)
	if err != nil || decoded.PairID != payload.PairID || decoded.Secret != payload.Secret || decoded.AuthKey == nil {
		t.Fatalf("round trip failed: %#v %v", decoded, err)
	}
	inspection, err := Inspect(encoded, now, false)
	if err != nil || inspection.Desktop.ID != payload.Desktop.ID || !inspection.HasAuthKey {
		t.Fatalf("inspection failed: %#v %v", inspection, err)
	}
	visible, _ := json.Marshal(inspection)
	if bytes.Contains(visible, []byte(payload.Secret)) || bytes.Contains(visible, []byte(*payload.AuthKey)) {
		t.Fatal("inspection exposed a pairing secret")
	}
}

func TestPayloadCodecRejectsInvalidInputWithStableCodes(t *testing.T) {
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	base := validPayload(now)
	for _, test := range []struct {
		name      string
		mutate    func(*Payload)
		allowHTTP bool
		code      string
	}{
		{"version", func(value *Payload) { value.Version = 2 }, false, "payload_version"},
		{"expired", func(value *Payload) { value.ExpiresAt = now.Add(-61 * time.Second).Unix() }, false, "payload_expired"},
		{"remote-http", func(value *Payload) { value.ControlURL = "http://example.com" }, true, "payload_invalid"},
		{"production-http", func(value *Payload) { value.ControlURL = "http://127.0.0.1:8080" }, false, "payload_invalid"},
		{"bad-user", func(value *Payload) { value.UserID = "not-a-number" }, false, "payload_invalid"},
		{"bad-desktop-id", func(value *Payload) { value.Desktop.ID = "d_short" }, false, "payload_invalid"},
		{"bad-node-key", func(value *Payload) { value.Desktop.NodeKey = "nodekey:short" }, false, "payload_invalid"},
		{"bad-ip", func(value *Payload) { value.Desktop.IP4 = "not-an-ip" }, false, "payload_invalid"},
		{"bad-secret", func(value *Payload) { value.Secret = "short" }, false, "payload_invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := base
			desktop := base.Desktop
			payload.Desktop = desktop
			test.mutate(&payload)
			raw, _ := json.Marshal(payload)
			text := Prefix + base64.RawURLEncoding.EncodeToString(raw)
			_, err := Inspect(text, now, test.allowHTTP)
			if Code(err) != test.code {
				t.Fatalf("expected %s, got %v", test.code, err)
			}
		})
	}

	raw, _ := json.Marshal(base)
	raw = bytes.Replace(raw, []byte(`"v":1`), []byte(`"v":1,"extra":true`), 1)
	if _, err := Decode(Prefix+base64.RawURLEncoding.EncodeToString(raw), false); Code(err) != "payload_invalid" {
		t.Fatalf("unknown field accepted: %v", err)
	}
	if _, err := Decode("NOTCIALAI."+base64.RawURLEncoding.EncodeToString(raw), false); Code(err) != "payload_invalid" {
		t.Fatalf("foreign QR accepted: %v", err)
	}
	if _, err := Decode(Prefix+strings.Repeat("a", MaxJSONBytes*2), false); Code(err) != "payload_invalid" {
		t.Fatalf("oversized QR accepted: %v", err)
	}
}

func TestSessionsAreSingleUseCancelableAndBlockRepeatedFailures(t *testing.T) {
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	clock := now
	sessions := NewSessions(func() time.Time { return clock }, bytes.NewReader(testEntropy(512)), false)
	active, err := sessions.Begin(validPayload(now), 17, 10*time.Minute)
	if err != nil || active.PreAuthKeyID != 17 || active.PairID == "" || active.Payload == "" {
		t.Fatalf("begin failed: %#v %v", active, err)
	}
	decoded, _ := Decode(active.Payload, false)
	if _, err := sessions.Consume(active.PairID, "wrong"); Code(err) != "pair_secret_mismatch" {
		t.Fatalf("wrong secret accepted: %v", err)
	}
	verified, err := sessions.Verify(active.PairID, decoded.Secret)
	if err != nil || verified.UserID != "42" || verified.Desktop.ID == "" {
		t.Fatalf("verification failed or consumed early: %#v %v", verified, err)
	}
	consumed, err := sessions.Consume(active.PairID, decoded.Secret)
	if err != nil || consumed.PreAuthKeyID != 17 {
		t.Fatalf("consume failed: %#v %v", consumed, err)
	}
	if _, err := sessions.Consume(active.PairID, decoded.Secret); Code(err) != "pair_consumed" {
		t.Fatalf("session replay accepted: %v", err)
	}

	cancelled, err := sessions.Begin(validPayload(now), 18, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if keyID, err := sessions.Cancel(cancelled.PairID); err != nil || keyID != 18 {
		t.Fatalf("cancel failed: %d %v", keyID, err)
	}
	if _, err := sessions.Consume(cancelled.PairID, "anything"); Code(err) != "pair_unknown" {
		t.Fatalf("cancelled session remained active: %v", err)
	}

	blocked, _ := sessions.Begin(validPayload(now), 19, time.Minute)
	for attempt := 0; attempt < MaxSecretFailures; attempt++ {
		_, _ = sessions.Consume(blocked.PairID, "wrong")
	}
	blockedPayload, _ := Decode(blocked.Payload, false)
	if _, err := sessions.Consume(blocked.PairID, blockedPayload.Secret); Code(err) != "pair_secret_mismatch" {
		t.Fatalf("blocked pair was accepted: %v", err)
	}

	expired, _ := sessions.Begin(validPayload(now), 20, time.Second)
	clock = now.Add(2 * time.Second)
	expiredPayload, _ := Decode(expired.Payload, false)
	if _, err := sessions.Consume(expired.PairID, expiredPayload.Secret); Code(err) != "pair_expired" {
		t.Fatalf("expired pair was accepted: %v", err)
	}
}

func TestSessionConsumeIsAtomic(t *testing.T) {
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	sessions := NewSessions(func() time.Time { return now }, bytes.NewReader(testEntropy(512)), false)
	active, _ := sessions.Begin(validPayload(now), 17, time.Minute)
	payload, _ := Decode(active.Payload, false)
	var wait sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for range 20 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if _, err := sessions.Consume(active.PairID, payload.Secret); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	wait.Wait()
	if successes != 1 {
		t.Fatalf("expected exactly one consumer, got %d", successes)
	}
}

func TestRegistryPersistsOnlyHashesAndHonorsTokenWindows(t *testing.T) {
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	clock := now
	paths, err := statedir.Prepare(filepath.Join(t.TempDir(), "tunnel"))
	if err != nil {
		t.Fatal(err)
	}
	identity := DesktopIdentity{ID: encodedID("d_", 16, 1), Name: "MacBook de Foco", CreatedAt: now}
	registry, err := OpenRegistry(paths, identity, func() time.Time { return clock }, bytes.NewReader(testEntropy(2048)))
	if err != nil {
		t.Fatal(err)
	}
	input := DeviceInput{Name: "iPhone de Foco", Model: "iPhone16,1", Platform: "ios", App: "1.0.0", NodeKey: "nodekey:" + strings.Repeat("b", 64), NodeID: "17", UserID: "42", IP4: "100.64.0.9", RemoteAddr: "100.64.0.9:51234"}
	device, token, err := registry.Pair(input)
	if err != nil || !strings.HasPrefix(token, "cdt1."+device.ID+".") {
		t.Fatalf("pair failed: %#v token present %v err %v", device, token != "", err)
	}
	if got, ok := registry.Authenticate(token); !ok || got.ID != device.ID {
		t.Fatal("fresh token was not accepted")
	}
	raw, err := os.ReadFile(paths.Devices)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(token)) || bytes.Contains(raw, []byte(strings.TrimPrefix(token, "cdt1."+device.ID+"."))) || !bytes.Contains(raw, []byte("sha256:")) {
		t.Fatal("device registry did not keep token hash only")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(paths.Devices)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("registry mode is %o", info.Mode().Perm())
		}
	}

	clock = now.Add(31 * 24 * time.Hour)
	if !registry.TokenRotationDue(device.ID) {
		t.Fatal("30-day token rotation was not requested")
	}
	rotated, err := registry.RotateToken(device.ID)
	if err != nil || rotated == token {
		t.Fatal("token rotation failed")
	}
	if _, ok := registry.Authenticate(token); !ok {
		t.Fatal("previous token was not accepted in grace window")
	}
	clock = clock.Add(24*time.Hour + time.Second)
	if _, ok := registry.Authenticate(token); ok {
		t.Fatal("previous token survived grace window")
	}
	if _, ok := registry.Authenticate(rotated); !ok {
		t.Fatal("rotated token was not accepted")
	}

	clock = clock.Add(time.Minute)
	sameDevice, repaired, err := registry.Pair(input)
	if err != nil || sameDevice.ID != device.ID || repaired == rotated {
		t.Fatal("re-pair did not retain device identity and replace token")
	}
	if _, ok := registry.Authenticate(rotated); ok {
		t.Fatal("re-pair left the previous token active")
	}
	if err := registry.Rename(device.ID, "Telefone pessoal"); err != nil {
		t.Fatal(err)
	}
	if err := registry.Revoke(device.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Authenticate(repaired); ok {
		t.Fatal("revoked device token was accepted")
	}
	public := registry.List()
	visible, _ := json.Marshal(public)
	if bytes.Contains(visible, []byte("tokenHash")) || len(public) != 1 || !public[0].Revoked || public[0].Name != "Telefone pessoal" {
		t.Fatalf("unsafe or wrong public list: %s", visible)
	}

	reopened, err := OpenRegistry(paths, identity, func() time.Time { return clock }, bytes.NewReader(testEntropy(512)))
	if err != nil || len(reopened.List()) != 1 {
		t.Fatalf("registry did not reopen: %v", err)
	}
	clock = clock.Add(31 * 24 * time.Hour)
	if removed, err := reopened.PruneRevoked(); err != nil || removed != 1 || len(reopened.List()) != 0 {
		t.Fatalf("revoked retention failed: removed %d err %v", removed, err)
	}
}

func TestRegistryRejectsCorruptOrMismatchedState(t *testing.T) {
	paths, _ := statedir.Prepare(filepath.Join(t.TempDir(), "tunnel"))
	now := time.Now().UTC()
	identity := DesktopIdentity{ID: encodedID("d_", 16, 1), Name: "Desktop", CreatedAt: now}
	if err := paths.WriteAtomic(paths.Devices, []byte(`{"version":2,"desktop":{"id":"wrong"},"devices":[]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRegistry(paths, identity, func() time.Time { return now }, bytes.NewReader(make([]byte, 512))); err == nil {
		t.Fatal("accepted an unsupported registry")
	}
	if Code(NewError("pair_unknown", "missing")) != "pair_unknown" {
		t.Fatal("pairing error lost its stable code")
	}
}
