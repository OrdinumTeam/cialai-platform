// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

const testBrotoName = "Broto do Escritório"

func testQR(t *testing.T, fill byte, expiresAt time.Time) (QR, string) {
	t.Helper()
	qr, err := NewQR(testPublicKey(fill), testBrotoName, "linux", expiresAt, bytes.NewReader(bytes.Repeat([]byte{fill}, QRSecretSize)))
	if err != nil {
		t.Fatal(err)
	}
	text, err := EncodeQR(qr)
	if err != nil {
		t.Fatal(err)
	}
	return qr, text
}

func qrFrame(raw []byte) string {
	return QRPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func testNonce(fill byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, QRNonceSize))
}

func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	if Code(err) != code {
		t.Fatalf("error = %v (%q), want %s", err, Code(err), code)
	}
}

func TestQRCodecRoundTripAndRejections(t *testing.T) {
	qr, text := testQR(t, 0x31, testNow.Add(QRTTL))
	if !strings.HasPrefix(text, QRPrefix) {
		t.Fatalf("payload %q lacks the prefix", text)
	}
	decoded, err := DecodeQR(text)
	if err != nil || decoded != qr {
		t.Fatalf("round trip = %+v, %v", decoded, err)
	}
	if decoded.Version != 1 || decoded.Key != identity.EncodePublicKey(testPublicKey(0x31)) || decoded.ExpiresAt != testNow.Add(QRTTL).Unix() || decoded.Name != testBrotoName || decoded.Platform != "linux" {
		t.Fatalf("decoded = %+v", decoded)
	}
	raw, _ := json.Marshal(qr)
	if !strings.HasPrefix(string(raw), `{"v":1,"k":"`) {
		t.Fatalf("field order changed: %s", raw)
	}
	if _, err := Decode(text); err == nil {
		t.Fatal("phone decoder accepted a Broto QR")
	}
	if _, err := DecodeBroto(text); err == nil {
		t.Fatal("CIALAIB2 decoder accepted a Broto QR")
	}

	mutate := func(change func(map[string]any)) string {
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		change(fields)
		mutated, _ := json.Marshal(fields)
		return qrFrame(mutated)
	}
	rejected := map[string]string{
		"other prefix":     "CIALAIQ2." + strings.TrimPrefix(text, QRPrefix),
		"phone prefix":     Prefix + strings.TrimPrefix(text, QRPrefix),
		"empty":            QRPrefix,
		"bad base64":       QRPrefix + "@@@",
		"too long":         qrFrame([]byte(`{"v":1,"n":"` + strings.Repeat("a", MaxQRJSONBytes) + `"}`)),
		"unknown field":    mutate(func(fields map[string]any) { fields["x"] = 1 }),
		"trailing data":    qrFrame(append(append([]byte{}, raw...), []byte(` {}`)...)),
		"version 2":        mutate(func(fields map[string]any) { fields["v"] = 2 }),
		"short key":        mutate(func(fields map[string]any) { fields["k"] = base64.RawURLEncoding.EncodeToString(make([]byte, 31)) }),
		"padded key":       mutate(func(fields map[string]any) { fields["k"] = qr.Key + "=" }),
		"short secret":     mutate(func(fields map[string]any) { fields["s"] = base64.RawURLEncoding.EncodeToString(make([]byte, 31)) }),
		"zero expiry":      mutate(func(fields map[string]any) { fields["e"] = 0 }),
		"blank name":       mutate(func(fields map[string]any) { fields["n"] = "   " }),
		"long name":        mutate(func(fields map[string]any) { fields["n"] = strings.Repeat("é", 49) }),
		"control name":     mutate(func(fields map[string]any) { fields["n"] = "Broto\n" }),
		"upper platform":   mutate(func(fields map[string]any) { fields["p"] = "Linux" }),
		"dashed platform":  mutate(func(fields map[string]any) { fields["p"] = "linux-gnu" }),
		"long platform":    mutate(func(fields map[string]any) { fields["p"] = strings.Repeat("a", 17) }),
		"missing platform": mutate(func(fields map[string]any) { delete(fields, "p") }),
		"spaced JSON":      qrFrame(bytes.Replace(raw, []byte(`"v":1,`), []byte(`"v": 1,`), 1)),
		"reordered JSON":   mutate(func(map[string]any) {}),
	}
	for name, payload := range rejected {
		if _, err := DecodeQR(payload); Code(err) != "qr_invalid" {
			t.Errorf("%s: error = %v (%q), want qr_invalid", name, err, Code(err))
		}
	}
	if _, err := EncodeQR(QR{Version: 1, Key: qr.Key, Secret: qr.Secret, ExpiresAt: qr.ExpiresAt, Name: "", Platform: "linux"}); Code(err) != "qr_invalid" {
		t.Fatalf("encoded a QR without name: %v", err)
	}
	longest := QR{Version: 1, Key: qr.Key, Secret: qr.Secret, ExpiresAt: qr.ExpiresAt, Name: strings.Repeat("<", 48), Platform: strings.Repeat("a", 16)}
	encoded, err := EncodeQR(longest)
	if err != nil {
		t.Fatalf("the longest valid QR does not fit: %v", err)
	}
	if back, err := DecodeQR(encoded); err != nil || back != longest {
		t.Fatalf("longest round trip = %+v, %v", back, err)
	}
}

func TestQRDerivationIsDeterministicAndSeparatesLabels(t *testing.T) {
	secret := make([]byte, QRSecretSize)
	for index := range secret {
		secret[index] = byte(index)
	}
	keys, err := DeriveQR(secret)
	if err != nil {
		t.Fatal(err)
	}
	// Reference values from an independent RFC 5869 implementation.
	if got := hex.EncodeToString(keys.OnionSeed[:]); got != "76f65c8b6b61066017a6f6c68f9b5f27da7d28d24f8ce4542d3136befd3dafcd" {
		t.Errorf("onion seed = %s", got)
	}
	if keys.PairID != "q_0Gv34E6IeHThBnCFRnELWg" {
		t.Errorf("pair id = %s", keys.PairID)
	}
	if keys.PairSecret != "r4JvmLfh7_e-VAC5BeoqO_36n1TyjGUg2PL-yuoiGh8" {
		t.Errorf("pair secret = %s", keys.PairSecret)
	}
	if got := hex.EncodeToString(keys.MarkerSeed[:]); got != "2459cb885f80e7ecb9c90a82188dd3d7e579fef32867700cb62bace32b05b259" {
		t.Errorf("marker seed = %s", got)
	}
	again, err := DeriveQR(secret)
	if err != nil || again != keys {
		t.Fatalf("derivation is not deterministic: %+v %v", again, err)
	}
	if !validEncodedID(keys.PairID, "q_", 16) || !validRawURLBytes(keys.PairSecret, 32) || keys.OnionSeed == keys.MarkerSeed {
		t.Fatalf("derived values overlap or have the wrong shape: %+v", keys)
	}
	if bytes.Equal(keys.MarkerKey(), keys.OnionSeed[:]) || len(keys.MarkerKey()) != 32 {
		t.Fatal("marker key is not an Ed25519 public key of its own")
	}
	secret[31] ^= 1
	other, err := DeriveQR(secret)
	if err != nil {
		t.Fatal(err)
	}
	if other.PairID == keys.PairID || other.PairSecret == keys.PairSecret || other.OnionSeed == keys.OnionSeed || other.MarkerSeed == keys.MarkerSeed {
		t.Fatal("another secret derived a shared value")
	}
	if _, err := DeriveQR(secret[:31]); Code(err) != "qr_invalid" {
		t.Fatalf("short secret = %v", err)
	}
	qr, _ := testQR(t, 0x31, testNow.Add(QRTTL))
	fromQR, err := qr.Derive()
	raw, _ := qr.SecretBytes()
	direct, _ := DeriveQR(raw)
	if err != nil || fromQR != direct {
		t.Fatalf("QR derivation = %+v %v", fromQR, err)
	}
}

func TestQRDigitsMatchFixedVectors(t *testing.T) {
	fill := func(value byte) []byte { return bytes.Repeat([]byte{value}, 32) }
	for _, vector := range []struct {
		host, broto, secret, nonce byte
		want                       string
	}{
		{1, 2, 3, 4, "3306"},
		{1, 2, 3, 5, "3298"},
		{9, 2, 3, 4, "0773"},
		{1, 2, 7, 4, "4481"},
	} {
		got := QRDigits(fill(vector.host), fill(vector.broto), fill(vector.secret), fill(vector.nonce))
		if got != vector.want {
			t.Errorf("digits(%d,%d,%d,%d) = %s, want %s", vector.host, vector.broto, vector.secret, vector.nonce, got, vector.want)
		}
	}
}

// qrHost is a host with one QR session and a Broto of key fill.
type qrHost struct {
	t        *testing.T
	now      time.Time
	sessions *Sessions
	qr       QR
	keys     QRKeys
	view     QRSession
	finished []DeviceInput
	notified []string
}

func newQRHost(t *testing.T, fill byte, requester string) *qrHost {
	t.Helper()
	host := &qrHost{t: t, now: testNow}
	host.sessions = NewSessions(func() time.Time { return host.now }, nil)
	host.sessions.OnQRChange(func(id string) { host.notified = append(host.notified, id) })
	var text string
	host.qr, text = testQR(t, fill, testNow.Add(QRTTL))
	view, keys, err := host.sessions.BeginQR(text, testDesktop("Host"), requester)
	if err != nil {
		t.Fatal(err)
	}
	host.keys, host.view = keys, view
	return host
}

func (host *qrHost) claim(fill byte, nonce string, confirmed bool) (bool, error) {
	return host.sessions.ClaimQR(host.keys.PairID, host.keys.PairSecret, nonce, confirmed, testDeviceInput(fill), func(input DeviceInput) error {
		host.finished = append(host.finished, input)
		return nil
	})
}

func (host *qrHost) stage() QRSession {
	host.t.Helper()
	view, err := host.sessions.QRState(host.keys.PairID)
	if err != nil {
		host.t.Fatal(err)
	}
	return view
}

func (host *qrHost) expectStage(stage string) QRSession {
	host.t.Helper()
	view := host.stage()
	if view.Stage != stage {
		host.t.Fatalf("stage = %s, want %s", view.Stage, stage)
	}
	return view
}

func (host *qrHost) digits(nonce string) string {
	secret, _ := host.qr.SecretBytes()
	raw, _ := base64.RawURLEncoding.DecodeString(nonce)
	return QRDigits(testPublicKey(0x11), testPublicKey(0x31), secret, raw)
}

func TestQRSessionNeedsTheBrotoKeyThePhoneAndTheConfirmation(t *testing.T) {
	host := newQRHost(t, 0x31, "dev_phone")
	if host.view.QRID != host.keys.PairID || host.view.Stage != QRStageWaiting || host.view.Name != testBrotoName || host.view.Platform != "linux" || host.view.Digits != "" {
		t.Fatalf("begin view = %+v", host.view)
	}
	if want := testNow.Add(QRTTL + QRGrace); !host.view.ExpiresAt.Equal(want) {
		t.Fatalf("expiresAt = %s, want %s", host.view.ExpiresAt, want)
	}
	if !host.sessions.PairingActive() {
		t.Fatal("a live QR session does not open the pairing gate")
	}
	if _, err := host.sessions.DecideQR(host.keys.PairID, true, "dev_phone"); Code(err) != "qr_not_ready" {
		t.Fatalf("approved before the claim: %v", err)
	}
	if _, err := host.claim(0x32, testNonce(1), false); Code(err) != "pair_claimed" {
		t.Fatalf("another key claimed: %v", err)
	}
	host.expectStage(QRStageWaiting)
	if _, err := host.sessions.ClaimQR(host.keys.PairID, testNonce(9), testNonce(1), false, testDeviceInput(0x31), nil); Code(err) != "pair_invalid" {
		t.Fatalf("wrong secret: %v", err)
	}
	if _, err := host.claim(0x31, "short", false); Code(err) != "pair_invalid" {
		t.Fatalf("malformed nonce: %v", err)
	}

	ready, err := host.claim(0x31, testNonce(1), true)
	if err != nil || ready {
		t.Fatalf("first claim = %v, %v", ready, err)
	}
	view := host.expectStage(QRStageVerify)
	if view.Digits != host.digits(testNonce(1)) {
		t.Fatalf("digits = %s, want %s", view.Digits, host.digits(testNonce(1)))
	}
	// The confirmation sent with a new nonce does not count.
	if ready, err = host.claim(0x31, testNonce(1), false); err != nil || ready {
		t.Fatalf("poll = %v, %v", ready, err)
	}
	if _, err := host.sessions.DecideQR(host.keys.PairID, true, "dev_other"); Code(err) != "qr_unknown" {
		t.Fatalf("another phone decided: %v", err)
	}
	stage, err := host.sessions.DecideQR(host.keys.PairID, true, "dev_phone")
	if err != nil || stage != QRStageApproved {
		t.Fatalf("approve = %s, %v", stage, err)
	}
	if host.stage().Digits == "" {
		t.Fatal("approved stage hides the digits")
	}
	if ready, err = host.claim(0x31, testNonce(1), false); err != nil || ready || len(host.finished) != 0 {
		t.Fatal("registered without the confirmation of the Broto", err)
	}

	// A new nonce replaces the old one, changes the digits and clears the
	// confirmation, while the approval stays.
	if ready, err = host.claim(0x31, testNonce(2), true); err != nil || ready {
		t.Fatalf("re-claim = %v, %v", ready, err)
	}
	view = host.expectStage(QRStageApproved)
	if view.Digits != host.digits(testNonce(2)) {
		t.Fatal("digits did not follow the new nonce")
	}
	// The confirmation of the replaced nonce is stale.
	if ready, err = host.claim(0x31, testNonce(1), true); err != nil || ready || len(host.finished) != 0 {
		t.Fatal("stale nonce confirmed the pairing", err)
	}
	if ready, err = host.claim(0x31, testNonce(1), true); err != nil || !ready || len(host.finished) != 1 {
		t.Fatalf("confirmed claim = %v, %v, %d", ready, err, len(host.finished))
	}
	registered := host.finished[0]
	if registered.Kind != identity.RoleBroto || registered.Name != testBrotoName || registered.Platform != "linux" || registered.DeviceKey != host.qr.Key || registered.Model != "iPhone16,1" {
		t.Fatalf("registered device = %+v", registered)
	}
	host.expectStage(QRStageDone)
	if host.stage().Digits != "" {
		t.Fatal("done stage shows digits")
	}
	if _, err := host.claim(0x31, testNonce(1), true); Code(err) != "pair_invalid" || len(host.finished) != 1 {
		t.Fatalf("replay after done: %v", err)
	}
	if host.sessions.PairingActive() {
		t.Fatal("a finished QR session keeps the pairing gate open")
	}
	if _, err := host.sessions.DecideQR(host.keys.PairID, false, "dev_phone"); Code(err) != "qr_not_ready" {
		t.Fatalf("denied after done: %v", err)
	}
	if len(host.notified) == 0 {
		t.Fatal("no change was notified")
	}
	for _, id := range host.notified {
		if id != host.keys.PairID {
			t.Fatalf("notified %s", id)
		}
	}
}

func TestQRSessionWithoutApprovalNeverRegisters(t *testing.T) {
	host := newQRHost(t, 0x31, "")
	for _, nonce := range []string{testNonce(1), testNonce(1), testNonce(1)} {
		if ready, err := host.claim(0x31, nonce, true); err != nil || ready {
			t.Fatalf("claim = %v, %v", ready, err)
		}
	}
	if len(host.finished) != 0 {
		t.Fatal("confirmation alone registered the Broto")
	}
	if stage, err := host.sessions.DecideQR(host.keys.PairID, true, "any phone"); err != nil || stage != QRStageApproved {
		t.Fatalf("approve without requester = %s, %v", stage, err)
	}
	if ready, err := host.claim(0x31, testNonce(1), false); err != nil || !ready || len(host.finished) != 1 {
		t.Fatalf("confirmed earlier, approved later = %v, %v", ready, err)
	}
}

func TestQRSessionDenialAndExpiryEnd(t *testing.T) {
	for _, stage := range []string{QRStageWaiting, QRStageVerify, QRStageApproved} {
		host := newQRHost(t, 0x31, "")
		if stage != QRStageWaiting {
			if _, err := host.claim(0x31, testNonce(1), false); err != nil {
				t.Fatal(err)
			}
		}
		if stage == QRStageApproved {
			if _, err := host.sessions.DecideQR(host.keys.PairID, true, ""); err != nil {
				t.Fatal(err)
			}
		}
		if result, err := host.sessions.DecideQR(host.keys.PairID, false, ""); err != nil || result != QRStageDenied {
			t.Fatalf("deny in %s = %s, %v", stage, result, err)
		}
		if _, err := host.claim(0x31, testNonce(1), true); Code(err) != "pair_denied" {
			t.Fatalf("claim after deny in %s: %v", stage, err)
		}
		host.expectStage(QRStageDenied)
		if _, err := host.sessions.DecideQR(host.keys.PairID, true, ""); Code(err) != "qr_not_ready" {
			t.Fatalf("approved after deny: %v", err)
		}
		if host.sessions.PairingActive() || len(host.finished) != 0 {
			t.Fatal("denied session stays usable")
		}
	}

	host := newQRHost(t, 0x31, "")
	if _, err := host.claim(0x31, testNonce(1), false); err != nil {
		t.Fatal(err)
	}
	if _, err := host.sessions.DecideQR(host.keys.PairID, true, ""); err != nil {
		t.Fatal(err)
	}
	host.now = host.view.ExpiresAt
	host.expectStage(QRStageExpired)
	if _, err := host.claim(0x31, testNonce(1), true); Code(err) != "pair_expired" || len(host.finished) != 0 {
		t.Fatalf("claim after expiry: %v", err)
	}
	if _, err := host.sessions.DecideQR(host.keys.PairID, false, ""); Code(err) != "qr_not_ready" {
		t.Fatalf("deny after expiry: %v", err)
	}
	if host.sessions.PairingActive() {
		t.Fatal("expired QR session keeps the pairing gate open")
	}
}

func TestQRSessionBeginRules(t *testing.T) {
	now := testNow
	sessions := NewSessions(func() time.Time { return now }, nil)
	desktop := testDesktop("Host")
	_, text := testQR(t, 0x31, now.Add(QRTTL))
	first, _, err := sessions.BeginQR(text, desktop, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := sessions.BeginQR(text, desktop, ""); Code(err) != "qr_used" {
		t.Fatalf("rescan: %v", err)
	}
	if err := sessions.Cancel(first.QRID); Code(err) != "pair_unknown" {
		t.Fatalf("pair.cancel dropped a QR session: %v", err)
	}
	_, second := testQR(t, 0x32, now.Add(QRTTL))
	if _, _, err := sessions.BeginQR(second, desktop, ""); err != nil {
		t.Fatal(err)
	}
	_, third := testQR(t, 0x33, now.Add(QRTTL))
	if _, _, err := sessions.BeginQR(third, desktop, ""); Code(err) != "qr_busy" {
		t.Fatalf("third live session: %v", err)
	}
	if _, err := sessions.DecideQR(first.QRID, false, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := sessions.BeginQR(third, desktop, ""); err != nil {
		t.Fatalf("a denied session still counts as live: %v", err)
	}
	if _, _, err := sessions.BeginQR(text, desktop, ""); Code(err) != "qr_used" {
		t.Fatalf("rescan after deny: %v", err)
	}
	// Ended sessions stay known as long as their QR could be scanned.
	now = first.ExpiresAt.Add(-time.Second)
	if _, _, err := sessions.BeginQR(text, desktop, ""); Code(err) != "qr_used" {
		t.Fatalf("rescan before expiry: %v", err)
	}
	now = first.ExpiresAt.Add(sessionRetention + time.Second)
	if _, _, err := sessions.BeginQR(text, desktop, ""); Code(err) != "qr_expired" {
		t.Fatalf("rescan after pruning: %v", err)
	}

	now = testNow
	fresh := NewSessions(func() time.Time { return now }, nil)
	_, late := testQR(t, 0x34, now.Add(-QRGrace))
	if _, _, err := fresh.BeginQR(late, desktop, ""); Code(err) != "qr_expired" {
		t.Fatalf("expired QR: %v", err)
	}
	_, edge := testQR(t, 0x35, now.Add(-QRGrace+time.Second))
	if _, _, err := fresh.BeginQR(edge, desktop, ""); err != nil {
		t.Fatalf("QR within the grace: %v", err)
	}
	_, ahead := testQR(t, 0x36, now.Add(QRTTL+QRGrace+time.Second))
	if _, _, err := fresh.BeginQR(ahead, desktop, ""); Code(err) != "qr_invalid" {
		t.Fatalf("QR from the future: %v", err)
	}
	_, limit := testQR(t, 0x37, now.Add(QRTTL+QRGrace))
	if _, _, err := fresh.BeginQR(limit, desktop, ""); err != nil {
		t.Fatalf("QR at the limit: %v", err)
	}
	if _, _, err := fresh.BeginQR("CIALAIB2.x", desktop, ""); Code(err) != "qr_invalid" {
		t.Fatalf("foreign code: %v", err)
	}
	if _, err := fresh.QRState("q_unknown"); Code(err) != "qr_unknown" {
		t.Fatalf("unknown state: %v", err)
	}
	if _, err := fresh.DecideQR("q_unknown", true, ""); Code(err) != "qr_unknown" {
		t.Fatalf("unknown decision: %v", err)
	}
}

func TestQRSessionsStayOutOfThePhoneAndCodeFlows(t *testing.T) {
	host := newQRHost(t, 0x31, "")
	if _, err := host.claim(0x31, testNonce(1), false); err != nil {
		t.Fatal(err)
	}
	if pending := host.sessions.PendingBrotos(); len(pending) != 0 {
		t.Fatalf("QR session listed as a CIALAIB2 request: %+v", pending)
	}
	if err := host.sessions.DecideBroto(host.keys.PairID, true); Code(err) != "pair_unknown" {
		t.Fatalf("CIALAIB2 decision on a QR session: %v", err)
	}
	if _, err := host.sessions.Consume(host.keys.PairID, host.keys.PairSecret); Code(err) != "pair_role" {
		t.Fatalf("phone consumed a QR session: %v", err)
	}
	if _, err := host.sessions.Verify(host.keys.PairID, host.keys.PairSecret); Code(err) != "pair_role" {
		t.Fatalf("phone verified a QR session: %v", err)
	}
	if _, err := host.sessions.PollBroto(host.keys.PairID, host.keys.PairSecret, testDeviceInput(0x31), func() error { return nil }); Code(err) != "pair_role" {
		t.Fatalf("CIALAIB2 poll on a QR session: %v", err)
	}
	host.expectStage(QRStageVerify)

	// The other flows cannot be claimed as QR sessions either.
	active, err := host.sessions.BeginBroto(Payload{Desktop: testDesktop("Host"), Onion: testOnion(testPublicKey(0x22), "443")})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := DecodeBroto(active.Payload)
	if _, err := host.sessions.ClaimQR(active.PairID, payload.Secret, testNonce(1), false, testDeviceInput(0x31), nil); Code(err) != "pair_invalid" {
		t.Fatalf("QR claim on a CIALAIB2 session: %v", err)
	}
}

func TestQRSessionLocksAfterRepeatedSecretFailures(t *testing.T) {
	host := newQRHost(t, 0x31, "")
	for range MaxSecretFailures {
		if _, err := host.sessions.ClaimQR(host.keys.PairID, testNonce(9), testNonce(1), false, testDeviceInput(0x31), nil); Code(err) != "pair_invalid" {
			t.Fatalf("wrong secret: %v", err)
		}
	}
	if _, err := host.claim(0x31, testNonce(1), false); Code(err) != "pair_invalid" {
		t.Fatalf("locked session accepted the right secret: %v", err)
	}
	if host.sessions.PairingActive() {
		t.Fatal("a locked QR session keeps the pairing gate open")
	}
}
