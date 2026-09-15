// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"crypto/ed25519"
	"regexp"
	"testing"
)

func TestApprovalCodeIsStableAndBoundToPairAndDevice(t *testing.T) {
	first := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	seed := make([]byte, ed25519.SeedSize)
	seed[0] = 1
	second := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)

	code := ApprovalCode("p_AAAAAAAAAAA", first)
	if !regexp.MustCompile(`^[0-9]{4}$`).MatchString(code) {
		t.Fatalf("code %q is not four digits", code)
	}
	if again := ApprovalCode("p_AAAAAAAAAAA", first); again != code {
		t.Fatalf("code changed between calls: %q and %q", code, again)
	}

	// Across many pairing ids a different device almost never shares the code;
	// a fixed collision rate near 1 in 10000 is what four digits allow.
	same := 0
	for index := 0; index < 2000; index++ {
		pairID := "p_" + string(rune('A'+index%26)) + string(rune('a'+(index/26)%26)) + "000000000"
		if ApprovalCode(pairID, first) == ApprovalCode(pairID, second) {
			same++
		}
	}
	if same > 5 {
		t.Fatalf("%d of 2000 pairing ids gave both devices the same code", same)
	}
	if ApprovalCode("p_AAAAAAAAAAA", first) == ApprovalCode("p_BBBBBBBBBBB", first) &&
		ApprovalCode("p_CCCCCCCCCCC", first) == ApprovalCode("p_DDDDDDDDDDD", first) {
		t.Fatal("the pairing id does not change the code")
	}
}
