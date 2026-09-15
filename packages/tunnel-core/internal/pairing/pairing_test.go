// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/cretz/bine/torutil"
	tored25519 "github.com/cretz/bine/torutil/ed25519"
)

// pairingGate is the view the direct transport consumes.
var _ interface{ PairingActive() bool } = (*Sessions)(nil)

const pairFixturePath = "../../../protocol/fixtures/pair-v2.json"

var testNow = time.Date(2026, 9, 14, 20, 0, 0, 0, time.UTC)

func testPublicKey(fill byte) ed25519.PublicKey {
	return ed25519.NewKeyFromSeed(bytes.Repeat([]byte{fill}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
}

func testDesktop(name string) Desktop {
	public := testPublicKey(0x11)
	id, err := identity.DeriveID(identity.RoleDesktop, public)
	if err != nil {
		panic(err)
	}
	return Desktop{ID: id, Name: name, PublicKey: identity.EncodePublicKey(public)}
}

func testOnion(public ed25519.PublicKey, port string) string {
	checksum := onionChecksum(public)
	raw := append(append(append([]byte{}, public...), checksum[:2]...), onionVersion)
	return strings.ToLower(onionEncoding.EncodeToString(raw)) + ".onion:" + port
}

func exampleCandidates() []Candidate {
	return []Candidate{
		{Type: CandidateLAN, Address: "192.168.15.23:4740"},
		{Type: CandidateLAN, Address: "10.0.0.23:4740"},
		{Type: CandidateIPv6, Address: "[2001:db8:4a2f:1c00:8d3e:5b71:9a0c:2e41]:4740"},
		{Type: CandidateIPv6, Address: "[2001:db8:4a2f:1c00::23]:4740"},
		{Type: CandidateMapped, Address: "203.0.113.45:61740"},
		{Type: CandidateSTUN, Address: "198.51.100.77:4740"},
	}
}

func worstCaseCandidates() []Candidate {
	candidates := make([]Candidate, MaxCandidates)
	for index := range candidates {
		candidates[index] = Candidate{Type: CandidateIPv6, Address: "[2001:db8:ffff:ffff:ffff:ffff:ffff:fff" + string(rune('0'+index)) + "]:65535"}
	}
	return candidates
}

// examplePayload is the fixture payload: six candidates, the onion address and
// fixed test-only secret values.
func examplePayload() Payload {
	return Payload{
		Version:    PayloadVersion,
		Desktop:    testDesktop("MacBook Pro do Escritório"),
		Onion:      testOnion(testPublicKey(0x22), "443"),
		Candidates: exampleCandidates(),
		Secret:     base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 32)),
		ExpiresAt:  time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC).Unix(),
		PairID:     "p_" + base64.RawURLEncoding.EncodeToString([]byte("fixture1")),
	}
}

func frame(raw []byte) string {
	return Prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func jsonBytes(t *testing.T, text string) []byte {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(text, Prefix))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func testEntropy(size int) []byte {
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index%251 + 1)
	}
	return data
}

func TestPayloadCodecRoundTripAndInspectionHidesSecrets(t *testing.T) {
	payload := examplePayload()
	payload.ExpiresAt = testNow.Add(10 * time.Minute).Unix()
	encoded, err := Encode(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encoded, Prefix) || strings.Contains(encoded, "=") {
		t.Fatalf("unexpected QR framing: %q", encoded)
	}
	decoded, err := Decode(encoded)
	if err != nil || !reflect.DeepEqual(decoded, payload) {
		t.Fatalf("round trip failed: %#v %v", decoded, err)
	}
	inspection, err := Inspect(encoded, testNow)
	if err != nil {
		t.Fatal(err)
	}
	public, _ := identity.ParsePublicKey(payload.Desktop.PublicKey)
	if inspection.Version != 2 || inspection.Desktop.ID != payload.Desktop.ID || inspection.Desktop.Name != payload.Desktop.Name ||
		inspection.Desktop.Fingerprint != identity.Fingerprint(public) || inspection.Candidates != 6 || inspection.ExpiresAt != payload.ExpiresAt {
		t.Fatalf("inspection is wrong: %#v", inspection)
	}
	visible, _ := json.Marshal(inspection)
	if bytes.Contains(visible, []byte(payload.Secret)) || bytes.Contains(visible, []byte(payload.PairID)) {
		t.Fatal("inspection exposed the pairing secret or id")
	}

	withoutCandidates := payload
	withoutCandidates.Candidates = nil
	encoded, err = Encode(withoutCandidates)
	if err != nil || !bytes.Contains(jsonBytes(t, encoded), []byte(`"c":[]`)) {
		t.Fatalf("onion-only payload was not encoded with an empty list: %v", err)
	}
	if decoded, err := Decode(encoded); err != nil || decoded.Candidates == nil || len(decoded.Candidates) != 0 {
		t.Fatalf("onion-only payload did not decode: %#v %v", decoded, err)
	}
}

func TestOnionValidationMatchesTorAddresses(t *testing.T) {
	public := testPublicKey(0x22)
	fromTor := torutil.OnionServiceIDFromV3PublicKey(tored25519.PublicKey(public)) + ".onion:443"
	if testOnion(public, "443") != fromTor || !validOnion(fromTor) {
		t.Fatalf("onion address differs from bine: %s", fromTor)
	}
	// Example address from the Tor rendezvous v3 specification.
	if !validOnion("pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion:443") {
		t.Fatal("specification example address was refused")
	}
}

func TestPayloadCodecRejectsInvalidInputWithStableCodes(t *testing.T) {
	base := examplePayload()
	base.ExpiresAt = testNow.Add(10 * time.Minute).Unix()
	otherDesktop := testPublicKey(0x33)
	validOnionKey := testPublicKey(0x22)
	badChecksum := []byte(testOnion(validOnionKey, "443"))
	badChecksum[53] ^= 'a' ^ 'b'
	for _, test := range []struct {
		name   string
		mutate func(*Payload)
		code   string
	}{
		{"version-1", func(value *Payload) { value.Version = 1 }, "payload_version"},
		{"version-3", func(value *Payload) { value.Version = 3 }, "payload_version"},
		{"expired", func(value *Payload) { value.ExpiresAt = testNow.Add(-61 * time.Second).Unix() }, "payload_expired"},
		{"missing-onion", func(value *Payload) { value.Onion = "" }, "payload_invalid"},
		{"onion-without-port", func(value *Payload) { value.Onion = strings.TrimSuffix(value.Onion, ":443") }, "payload_invalid"},
		{"onion-port-zero", func(value *Payload) { value.Onion = strings.TrimSuffix(value.Onion, "443") + "0" }, "payload_invalid"},
		{"onion-port-padded", func(value *Payload) { value.Onion = strings.TrimSuffix(value.Onion, "443") + "0443" }, "payload_invalid"},
		{"onion-uppercase", func(value *Payload) { value.Onion = strings.ToUpper(value.Onion[:56]) + value.Onion[56:] }, "payload_invalid"},
		{"onion-bad-checksum", func(value *Payload) { value.Onion = string(badChecksum) }, "payload_invalid"},
		{"onion-v2", func(value *Payload) { value.Onion = "expyuzz4wqqyqhjn.onion:443" }, "payload_invalid"},
		{"onion-clearnet", func(value *Payload) { value.Onion = "example.com:443" }, "payload_invalid"},
		{"desktop-id-not-derived", func(value *Payload) { value.Desktop.PublicKey = identity.EncodePublicKey(otherDesktop) }, "payload_invalid"},
		{"desktop-key-invalid", func(value *Payload) { value.Desktop.PublicKey = "short" }, "payload_invalid"},
		{"desktop-name-empty", func(value *Payload) { value.Desktop.Name = "" }, "payload_invalid"},
		{"desktop-name-control", func(value *Payload) { value.Desktop.Name = "Mac\nfalso" }, "payload_invalid"},
		{"desktop-name-long", func(value *Payload) { value.Desktop.Name = strings.Repeat("a", 49) }, "payload_invalid"},
		{"seven-candidates", func(value *Payload) {
			value.Candidates = append(value.Candidates[:6:6], Candidate{Type: CandidateLAN, Address: "192.168.15.24:4740"})
		}, "payload_invalid"},
		{"duplicate-candidate", func(value *Payload) { value.Candidates = []Candidate{value.Candidates[0], value.Candidates[0]} }, "payload_invalid"},
		{"unknown-candidate-type", func(value *Payload) { value.Candidates = []Candidate{{Type: "relay", Address: "203.0.113.1:4740"}} }, "payload_invalid"},
		{"lan-with-public-address", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateLAN, Address: "203.0.113.1:4740"}}
		}, "payload_invalid"},
		{"ipv6-with-ipv4", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateIPv6, Address: "203.0.113.1:4740"}}
		}, "payload_invalid"},
		{"mapped-with-private", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateMapped, Address: "192.168.1.1:4740"}}
		}, "payload_invalid"},
		{"candidate-not-canonical", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateIPv6, Address: "[2001:0db8::23]:4740"}}
		}, "payload_invalid"},
		{"candidate-port-zero", func(value *Payload) { value.Candidates = []Candidate{{Type: CandidateLAN, Address: "10.0.0.2:0"}} }, "payload_invalid"},
		{"candidate-without-port", func(value *Payload) { value.Candidates = []Candidate{{Type: CandidateLAN, Address: "10.0.0.2"}} }, "payload_invalid"},
		{"candidate-zone", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateLAN, Address: "[fd00::1%en0]:4740"}}
		}, "payload_invalid"},
		{"candidate-link-local", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateLAN, Address: "169.254.1.1:4740"}}
		}, "payload_invalid"},
		{"candidate-mapped-v4-in-v6", func(value *Payload) {
			value.Candidates = []Candidate{{Type: CandidateLAN, Address: "[::ffff:10.0.0.2]:4740"}}
		}, "payload_invalid"},
		{"candidate-hostname", func(value *Payload) { value.Candidates = []Candidate{{Type: CandidateLAN, Address: "mac.local:4740"}} }, "payload_invalid"},
		{"bad-secret", func(value *Payload) { value.Secret = "short" }, "payload_invalid"},
		{"bad-pair-id", func(value *Payload) { value.PairID = "p_short" }, "payload_invalid"},
		{"no-expiration", func(value *Payload) { value.ExpiresAt = 0 }, "payload_invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := base
			payload.Candidates = append([]Candidate{}, base.Candidates...)
			test.mutate(&payload)
			raw, _ := json.Marshal(payload)
			if _, err := Inspect(frame(raw), testNow); Code(err) != test.code {
				t.Fatalf("expected %s, got %v", test.code, err)
			}
			if test.code == "payload_invalid" || test.code == "payload_version" {
				if _, err := Encode(payload); Code(err) != test.code {
					t.Fatalf("encoder accepted what the decoder refuses: %v", err)
				}
			}
		})
	}

	accepted := base
	accepted.Candidates = []Candidate{
		{Type: CandidateLAN, Address: "127.0.0.1:4740"},
		{Type: CandidateLAN, Address: "[fd7a:115c:a1e0::23]:4740"},
		{Type: CandidateLAN, Address: "100.100.1.2:4740"},
		{Type: CandidateMapped, Address: "[2001:db8::45]:61740"},
		{Type: CandidateMapped, Address: "100.64.0.9:61740"},
	}
	if _, err := Encode(accepted); err != nil {
		t.Fatalf("valid loopback, ULA, shared LAN, IPv6 mapped and CGNAT candidates were refused: %v", err)
	}
}

func TestDecodeRejectsUnknownFieldsAlternateSpellingsAndForeignFrames(t *testing.T) {
	payload := examplePayload()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decode(frame(raw)); err != nil {
		t.Fatalf("canonical payload refused: %v", err)
	}
	replace := func(old, replacement string) []byte {
		if !bytes.Contains(raw, []byte(old)) {
			t.Fatalf("fixture JSON lacks %q", old)
		}
		return bytes.Replace(raw, []byte(old), []byte(replacement), 1)
	}
	for _, test := range []struct {
		name string
		raw  []byte
		code string
	}{
		{"unknown-top-level", replace(`"v":2`, `"v":2,"k":"hskey-auth"`), "payload_invalid"},
		{"unknown-desktop", replace(`"n":`, `"ip4":"100.64.0.3","n":`), "payload_invalid"},
		{"unknown-candidate", replace(`"t":"lan"`, `"t":"lan","p":"udp"`), "payload_invalid"},
		{"case-variant-key", replace(`"pid":`, `"PID":`), "payload_invalid"},
		{"duplicate-key", replace(`"v":2`, `"v":2,"v":2`), "payload_invalid"},
		{"whitespace", replace(`"v":2`, `"v": 2`), "payload_invalid"},
		{"trailing-object", append(append([]byte{}, raw...), []byte(`{}`)...), "payload_invalid"},
		{"not-json", []byte(`CIALAI`), "payload_invalid"},
		{"legacy-version-field", replace(`"v":2`, `"v":1`), "payload_version"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Decode(frame(test.raw)); Code(err) != test.code {
				t.Fatalf("expected %s, got %v", test.code, err)
			}
		})
	}
	nullCandidates := payload
	nullCandidates.Candidates = nil
	nullRaw, _ := json.Marshal(nullCandidates)
	if !bytes.Contains(nullRaw, []byte(`"c":null`)) {
		t.Fatalf("null candidate list was not produced: %s", nullRaw)
	}
	if _, err := Decode(frame(nullRaw)); Code(err) != "payload_invalid" {
		t.Fatalf("null candidate list accepted: %v", err)
	}
	without := func(field string, value any) []byte {
		encodedValue, _ := json.Marshal(value)
		segment := append(append([]byte(`"`+field+`":`), encodedValue...), ',')
		if !bytes.Contains(raw, segment) {
			t.Fatalf("fixture JSON lacks %s", segment)
		}
		return bytes.Replace(raw, segment, nil, 1)
	}
	_, err = Decode(frame(without("o", payload.Onion)))
	if Code(err) != "payload_invalid" || !strings.Contains(err.Error(), "endereço de reserva") {
		t.Fatalf("payload without onion was not refused for the missing onion: %v", err)
	}
	for field, value := range map[string]any{"d": payload.Desktop, "c": payload.Candidates, "s": payload.Secret, "e": payload.ExpiresAt} {
		if _, err := Decode(frame(without(field, value))); Code(err) != "payload_invalid" {
			t.Fatalf("payload without %q accepted: %v", field, err)
		}
	}

	if _, err := Decode("CIALAI1." + base64.RawURLEncoding.EncodeToString(raw)); Code(err) != "payload_version" {
		t.Fatalf("legacy QR was not recognized as an old version: %v", err)
	}
	if _, err := Decode("NOTCIALAI." + base64.RawURLEncoding.EncodeToString(raw)); Code(err) != "payload_invalid" {
		t.Fatalf("foreign QR accepted: %v", err)
	}
	if _, err := Decode(Prefix); Code(err) != "payload_invalid" {
		t.Fatalf("empty QR accepted: %v", err)
	}
	if _, err := Decode(Prefix + "not*base64"); Code(err) != "payload_invalid" {
		t.Fatalf("corrupt QR accepted: %v", err)
	}
	if _, err := Decode(frame(raw) + "=="); Code(err) != "payload_invalid" {
		t.Fatalf("padded QR accepted: %v", err)
	}
}

func TestPayloadSizeLimitWithSixCandidatesAndOnion(t *testing.T) {
	example := examplePayload()
	encoded, err := Encode(example)
	if err != nil {
		t.Fatal(err)
	}
	if size := len(jsonBytes(t, encoded)); size >= MaxJSONBytes {
		t.Fatalf("example payload with six candidates and onion has %d bytes", size)
	}

	oversized := example
	oversized.Desktop = testDesktop(strings.Repeat("M", 48))
	oversized.Candidates = worstCaseCandidates()
	if _, err := Encode(oversized); Code(err) != "payload_invalid" {
		t.Fatalf("oversized payload was encoded: %v", err)
	}
	raw, _ := json.Marshal(oversized)
	if len(raw) <= MaxJSONBytes {
		t.Fatalf("worst case is not above the limit: %d bytes", len(raw))
	}
	if _, err := Decode(frame(raw)); Code(err) != "payload_invalid" {
		t.Fatalf("oversized payload was decoded: %v", err)
	}
	if _, err := Decode(Prefix + strings.Repeat("a", MaxJSONBytes*2)); Code(err) != "payload_invalid" {
		t.Fatalf("oversized QR accepted: %v", err)
	}
}

func TestPairV2FixtureMatchesTheCodec(t *testing.T) {
	type fixture struct {
		Payload   string  `json:"payload"`
		JSONBytes int     `json:"jsonBytes"`
		JSON      Payload `json:"json"`
	}
	example := examplePayload()
	encoded, err := Encode(example)
	if err != nil {
		t.Fatal(err)
	}
	expected := fixture{Payload: encoded, JSONBytes: len(jsonBytes(t, encoded)), JSON: example}
	if os.Getenv("CIALAI_UPDATE_PAIR_FIXTURE") == "1" {
		raw, err := json.MarshalIndent(expected, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.FromSlash(pairFixturePath), append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(filepath.FromSlash(pairFixturePath))
	if err != nil {
		t.Fatalf("read fixture (regenerate with CIALAI_UPDATE_PAIR_FIXTURE=1): %v", err)
	}
	var stored fixture
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored, expected) {
		t.Fatalf("fixture is stale (regenerate with CIALAI_UPDATE_PAIR_FIXTURE=1):\n%+v\n%+v", stored, expected)
	}
	decoded, err := Decode(stored.Payload)
	if err != nil || !reflect.DeepEqual(decoded, stored.JSON) {
		t.Fatalf("fixture payload does not decode to its JSON: %v", err)
	}
	if stored.JSONBytes >= MaxJSONBytes || len(stored.JSON.Candidates) != MaxCandidates || stored.JSON.Onion == "" {
		t.Fatalf("fixture must have six candidates and the onion under %d bytes: %d", MaxJSONBytes, stored.JSONBytes)
	}
}

func TestSessionsAreSingleUseAndRefuseReplay(t *testing.T) {
	clock := testNow
	sessions := NewSessions(func() time.Time { return clock }, bytes.NewReader(testEntropy(512)))
	if sessions.PairingActive() {
		t.Fatal("pairing active without sessions")
	}
	active, err := sessions.Begin(examplePayload(), DefaultSessionTTL)
	if err != nil || active.PairID == "" || !active.ExpiresAt.Equal(testNow.Add(600*time.Second)) {
		t.Fatalf("begin failed: %#v %v", active, err)
	}
	decoded, err := Decode(active.Payload)
	if err != nil || decoded.PairID != active.PairID || decoded.ExpiresAt != active.ExpiresAt.Unix() || decoded.Onion == "" || len(decoded.Candidates) != 6 {
		t.Fatalf("session payload is wrong: %#v %v", decoded, err)
	}
	if !sessions.PairingActive() {
		t.Fatal("pairing not active after begin")
	}
	if _, err := sessions.Consume(active.PairID, "wrong"); Code(err) != "pair_secret_mismatch" {
		t.Fatalf("wrong secret accepted: %v", err)
	}
	verified, err := sessions.Verify(active.PairID, decoded.Secret)
	if err != nil || verified.Desktop != decoded.Desktop || verified.PairID != active.PairID {
		t.Fatalf("verification failed or consumed early: %#v %v", verified, err)
	}
	consumed, err := sessions.Consume(active.PairID, decoded.Secret)
	if err != nil || consumed.Desktop.ID != decoded.Desktop.ID {
		t.Fatalf("consume failed: %#v %v", consumed, err)
	}
	if sessions.PairingActive() {
		t.Fatal("pairing still active after the only session was consumed")
	}
	if _, err := sessions.Consume(active.PairID, decoded.Secret); Code(err) != "pair_consumed" {
		t.Fatalf("session replay accepted: %v", err)
	}
	if _, err := sessions.Verify(active.PairID, decoded.Secret); Code(err) != "pair_consumed" {
		t.Fatalf("session replay verified: %v", err)
	}

	cancelled, err := sessions.Begin(examplePayload(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	cancelledPayload, _ := Decode(cancelled.Payload)
	if err := sessions.Cancel(cancelled.PairID); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Consume(cancelled.PairID, cancelledPayload.Secret); Code(err) != "pair_unknown" {
		t.Fatalf("cancelled session remained active: %v", err)
	}
	if err := sessions.Cancel(cancelled.PairID); Code(err) != "pair_unknown" {
		t.Fatalf("second cancel succeeded: %v", err)
	}

	blocked, _ := sessions.Begin(examplePayload(), time.Minute)
	for attempt := 0; attempt < MaxSecretFailures; attempt++ {
		_, _ = sessions.Verify(blocked.PairID, "wrong")
	}
	blockedPayload, _ := Decode(blocked.Payload)
	if _, err := sessions.Consume(blocked.PairID, blockedPayload.Secret); Code(err) != "pair_secret_mismatch" {
		t.Fatalf("blocked pair was accepted: %v", err)
	}
	if sessions.PairingActive() {
		t.Fatal("a session blocked by failures keeps pairing active")
	}
}

func TestSessionsExpireAndArePruned(t *testing.T) {
	clock := testNow
	sessions := NewSessions(func() time.Time { return clock }, bytes.NewReader(testEntropy(1024)))
	for _, ttl := range []time.Duration{0, -time.Second, MaxSessionTTL + time.Second} {
		if _, err := sessions.Begin(examplePayload(), ttl); Code(err) != "payload_invalid" {
			t.Fatalf("ttl %s accepted: %v", ttl, err)
		}
	}
	expired, err := sessions.Begin(examplePayload(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	expiredPayload, _ := Decode(expired.Payload)
	clock = testNow.Add(999 * time.Millisecond)
	if !sessions.PairingActive() {
		t.Fatal("session inactive before its expiration")
	}
	clock = testNow.Add(time.Second)
	if sessions.PairingActive() {
		t.Fatal("expired session keeps pairing active")
	}
	if _, err := sessions.Consume(expired.PairID, expiredPayload.Secret); Code(err) != "pair_expired" {
		t.Fatalf("expired pair was accepted: %v", err)
	}
	if _, err := Inspect(expired.Payload, clock.Add(2*time.Minute)); Code(err) != "payload_expired" {
		t.Fatalf("expired QR inspected: %v", err)
	}

	clock = testNow.Add(time.Second + sessionRetention + time.Second)
	if _, err := sessions.Begin(examplePayload(), time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Consume(expired.PairID, expiredPayload.Secret); Code(err) != "pair_unknown" {
		t.Fatalf("expired session was not pruned: %v", err)
	}
}

func TestSessionBeginKeepsTheOnionAndDropsCandidatesThatDoNotFit(t *testing.T) {
	sessions := NewSessions(func() time.Time { return testNow }, bytes.NewReader(testEntropy(1024)))
	template := examplePayload()
	template.Desktop = testDesktop(strings.Repeat("M", 48))
	template.Candidates = append(worstCaseCandidates(), Candidate{Type: CandidateLAN, Address: "192.168.1.9:4740"})
	callerCandidates := append([]Candidate{}, template.Candidates...)
	active, err := sessions.Begin(template, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode(active.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.Candidates) == 0 || len(decoded.Candidates) >= MaxCandidates || decoded.Onion != template.Onion {
		t.Fatalf("expected trimmed candidates with the onion, got %d candidates", len(decoded.Candidates))
	}
	if !reflect.DeepEqual(decoded.Candidates, template.Candidates[:len(decoded.Candidates)]) || len(jsonBytes(t, active.Payload)) > MaxJSONBytes {
		t.Fatal("trimming did not keep the highest priority candidates within the limit")
	}
	if !reflect.DeepEqual(template.Candidates, callerCandidates) {
		t.Fatal("begin modified the caller's candidates")
	}

	withoutOnion := examplePayload()
	withoutOnion.Onion = ""
	if _, err := sessions.Begin(withoutOnion, time.Minute); Code(err) != "payload_invalid" {
		t.Fatalf("session without onion accepted: %v", err)
	}
}

func TestSessionBeginSkipsInvalidAndRepeatedCandidates(t *testing.T) {
	sessions := NewSessions(func() time.Time { return testNow }, bytes.NewReader(testEntropy(512)))
	valid := exampleCandidates()
	template := examplePayload()
	template.Candidates = []Candidate{
		{Type: CandidateLAN, Address: "169.254.10.2:4740"},
		valid[0],
		{Type: CandidateLAN, Address: "mac.local:4740"},
		valid[0],
		{Type: "relay", Address: "203.0.113.9:4740"},
		valid[1], valid[2], valid[3], valid[4], valid[5],
		{Type: CandidateLAN, Address: "192.168.15.99:4740"},
	}
	active, err := sessions.Begin(template, time.Minute)
	if err != nil {
		t.Fatalf("invalid discovered candidates blocked pairing: %v", err)
	}
	decoded, err := Decode(active.Payload)
	if err != nil || !reflect.DeepEqual(decoded.Candidates, valid) {
		t.Fatalf("expected the six valid candidates in priority order: %#v %v", decoded.Candidates, err)
	}

	onlyInvalid := examplePayload()
	onlyInvalid.Candidates = []Candidate{{Type: CandidateLAN, Address: "[fe80::1]:4740"}}
	active, err = sessions.Begin(onlyInvalid, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := Decode(active.Payload); err != nil || len(decoded.Candidates) != 0 || decoded.Onion != onlyInvalid.Onion {
		t.Fatalf("expected an onion-only payload: %#v %v", decoded, err)
	}
}

func TestSessionConsumeIsAtomic(t *testing.T) {
	sessions := NewSessions(func() time.Time { return testNow }, bytes.NewReader(testEntropy(512)))
	active, _ := sessions.Begin(examplePayload(), time.Minute)
	payload, _ := Decode(active.Payload)
	var wait sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for range 20 {
		wait.Add(2)
		go func() {
			defer wait.Done()
			if _, err := sessions.Consume(active.PairID, payload.Secret); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
		go func() {
			defer wait.Done()
			_ = sessions.PairingActive()
		}()
	}
	wait.Wait()
	if successes != 1 || sessions.PairingActive() {
		t.Fatalf("expected exactly one consumer, got %d", successes)
	}
}
