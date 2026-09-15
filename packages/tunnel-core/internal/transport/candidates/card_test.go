// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
)

var cardNow = time.Date(2026, 9, 14, 20, 0, 0, 500, time.UTC)

func testCardInputs(t *testing.T) (pairing.Desktop, string) {
	t.Helper()
	desktop, err := identity.Generate(identity.RoleDesktop, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := tor.GenerateOnionKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pairing.Desktop{ID: desktop.ID(), Name: "Mac do estúdio", PublicKey: desktop.PublicKeyString()}, key.Address() + ":443"
}

func TestCardRoundTripKeepsQRFormats(t *testing.T) {
	desktop, onion := testCardInputs(t)
	candidates := []pairing.Candidate{
		{Type: pairing.CandidateLAN, Address: "192.168.1.10:4740"},
		{Type: pairing.CandidateLAN, Address: "192.168.1.10:4740"},
		{Type: pairing.CandidateLAN, Address: "8.8.8.8:4740"},
		{Type: pairing.CandidateIPv6, Address: "[2804:14d:5c21:1::10]:4740"},
		{Type: pairing.CandidateMapped, Address: "198.51.100.20:61000"},
	}
	card, err := NewCard(desktop, onion, candidates, cardNow, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(card.Candidates) != 3 || card.IssuedAt != cardNow.Truncate(time.Second) || card.ExpiresAt != card.IssuedAt.Add(DefaultCardTTL) {
		t.Fatalf("card = %+v", card)
	}
	raw, err := EncodeCard(card)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"v":1`, `"desktop":{"id":`, `"n":"Mac do estúdio"`, `"k":`, `"onion":`, `"candidates":[{"t":"lan","a":"192.168.1.10:4740"}`, `"issuedAt":"2026-09-14T20:00:00Z"`, `"expiresAt":"2026-09-15T20:00:00Z"`} {
		if !strings.Contains(string(raw), field) {
			t.Fatalf("card JSON %s lacks %s", raw, field)
		}
	}
	decoded, err := DecodeCard(raw)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Desktop != card.Desktop || decoded.Onion != card.Onion || !slices.Equal(decoded.Candidates, card.Candidates) ||
		!decoded.IssuedAt.Equal(card.IssuedAt) || !decoded.ExpiresAt.Equal(card.ExpiresAt) {
		t.Fatalf("decoded = %+v, want %+v", decoded, card)
	}
	if decoded.Expired(card.ExpiresAt.Add(-time.Second)) || !decoded.Expired(card.ExpiresAt) {
		t.Fatal("Expired must flip exactly at ExpiresAt")
	}
}

func TestCardCapsCandidates(t *testing.T) {
	desktop, onion := testCardInputs(t)
	var candidates []pairing.Candidate
	for index := range MaxCardCandidates + 4 {
		candidates = append(candidates, pairing.Candidate{Type: pairing.CandidateLAN, Address: fmt.Sprintf("10.0.%d.1:4740", index)})
	}
	card, err := NewCard(desktop, onion, candidates, cardNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(card.Candidates) != MaxCardCandidates || card.Candidates[0].Address != "10.0.0.1:4740" {
		t.Fatalf("card candidates = %v", card.Candidates)
	}
	empty, err := NewCard(desktop, onion, nil, cardNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := EncodeCard(empty); err != nil || !strings.Contains(string(raw), `"candidates":[]`) {
		t.Fatalf("empty card = %s, %v", raw, err)
	}
}

func TestCardRejectsInvalidInput(t *testing.T) {
	desktop, onion := testCardInputs(t)
	valid, err := NewCard(desktop, onion, []pairing.Candidate{{Type: pairing.CandidateLAN, Address: "192.168.1.10:4740"}}, cardNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := EncodeCard(valid)
	if err != nil {
		t.Fatal(err)
	}
	wrongID := desktop
	wrongID.ID = "d_AAAAAAAAAAAAAAAAAAAAAA"
	if _, err := NewCard(wrongID, onion, nil, cardNow, time.Hour); !errors.Is(err, ErrCardInvalid) {
		t.Fatalf("desktop id not derived from the key accepted: %v", err)
	}
	if _, err := NewCard(desktop, "example.onion:443", nil, cardNow, time.Hour); !errors.Is(err, ErrCardInvalid) {
		t.Fatalf("invalid onion accepted: %v", err)
	}
	if _, err := NewCard(desktop, onion, nil, cardNow, MaxCardTTL+time.Second); !errors.Is(err, ErrCardInvalid) {
		t.Fatalf("validity beyond MaxCardTTL accepted: %v", err)
	}
	if _, err := NewCard(desktop, onion, nil, cardNow, -time.Hour); !errors.Is(err, ErrCardInvalid) {
		t.Fatalf("negative validity accepted: %v", err)
	}
	text := string(raw)
	for name, mutated := range map[string]string{
		"unknown field":      strings.Replace(text, `"v":1`, `"v":1,"extra":true`, 1),
		"trailing data":      text + `{}`,
		"version":            strings.Replace(text, `"v":1`, `"v":2`, 1),
		"duplicate address":  strings.Replace(text, `"candidates":[{"t":"lan","a":"192.168.1.10:4740"}]`, `"candidates":[{"t":"lan","a":"192.168.1.10:4740"},{"t":"lan","a":"192.168.1.10:4740"}]`, 1),
		"wrong type":         strings.Replace(text, `{"t":"lan","a":"192.168.1.10:4740"}`, `{"t":"mapped","a":"192.168.1.10:4740"}`, 1),
		"null candidates":    strings.Replace(text, `[{"t":"lan","a":"192.168.1.10:4740"}]`, `null`, 1),
		"expires before":     strings.Replace(text, `"expiresAt":"2026-09-14T21:00:00Z"`, `"expiresAt":"2026-09-14T19:00:00Z"`, 1),
		"oversized document": strings.Replace(text, `"v":1`, `"v":1`+strings.Repeat(" ", MaxCardBytes), 1),
	} {
		if mutated == text {
			t.Fatalf("%s: mutation did not apply to %s", name, text)
		}
		if _, err := DecodeCard([]byte(mutated)); !errors.Is(err, ErrCardInvalid) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
}
