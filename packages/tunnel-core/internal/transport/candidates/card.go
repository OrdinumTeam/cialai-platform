// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

const (
	CardVersion = 1
	// DefaultCardTTL is how long the candidates of a card stay trustworthy.
	DefaultCardTTL = 24 * time.Hour
	// MaxCardTTL caps the validity a desktop may declare.
	MaxCardTTL = 7 * 24 * time.Hour
	// MaxCardCandidates is larger than the QR limit because the card is not
	// bound to the QR size.
	MaxCardCandidates = 16
	MaxCardBytes      = 4096
)

var ErrCardInvalid = errors.New("reach card is invalid")

// Card is the reach card: the desktop identity pinned by the phone, the onion
// address and the direct candidates, with the time they were collected. The
// edge returns it at the end of pairing and the control channel renews it. It
// reuses the desktop and candidate formats of the QR.
//
// An expired card still pins the key and the onion, which derive from
// persisted keys; only its candidates stop being worth dialing.
type Card struct {
	Version    int                 `json:"v"`
	Desktop    pairing.Desktop     `json:"desktop"`
	Onion      string              `json:"onion"`
	Candidates []pairing.Candidate `json:"candidates"`
	IssuedAt   time.Time           `json:"issuedAt"`
	ExpiresAt  time.Time           `json:"expiresAt"`
}

// NewCard builds a card valid for ttl, or DefaultCardTTL when ttl is zero.
// Candidates come from discovery, so invalid or repeated ones and those beyond
// MaxCardCandidates are skipped, keeping the priority order.
func NewCard(desktop pairing.Desktop, onion string, candidates []pairing.Candidate, issuedAt time.Time, ttl time.Duration) (Card, error) {
	if ttl == 0 {
		ttl = DefaultCardTTL
	}
	issuedAt = issuedAt.UTC().Truncate(time.Second)
	card := Card{
		Version:    CardVersion,
		Desktop:    desktop,
		Onion:      onion,
		Candidates: usableCardCandidates(candidates),
		IssuedAt:   issuedAt,
		ExpiresAt:  issuedAt.Add(ttl),
	}
	if err := card.Validate(); err != nil {
		return Card{}, err
	}
	return card, nil
}

// Validate checks the card with the QR rules for the desktop, the onion and
// each candidate.
func (card Card) Validate() error {
	switch {
	case card.Version != CardVersion:
		return fmt.Errorf("%w: unsupported version %d", ErrCardInvalid, card.Version)
	case !pairing.ValidDesktop(card.Desktop):
		return fmt.Errorf("%w: desktop identity", ErrCardInvalid)
	case !pairing.ValidOnion(card.Onion):
		return fmt.Errorf("%w: onion address", ErrCardInvalid)
	case card.Candidates == nil || len(card.Candidates) > MaxCardCandidates:
		return fmt.Errorf("%w: candidate list", ErrCardInvalid)
	case card.IssuedAt.IsZero() || !card.ExpiresAt.After(card.IssuedAt) || card.ExpiresAt.Sub(card.IssuedAt) > MaxCardTTL:
		return fmt.Errorf("%w: validity", ErrCardInvalid)
	}
	seen := make(map[string]bool, len(card.Candidates))
	for _, candidate := range card.Candidates {
		if !pairing.ValidCandidate(candidate) || seen[candidate.Address] {
			return fmt.Errorf("%w: candidate %q", ErrCardInvalid, candidate.Address)
		}
		seen[candidate.Address] = true
	}
	return nil
}

// Expired reports whether the candidates of the card are past their validity.
func (card Card) Expired(now time.Time) bool { return !now.Before(card.ExpiresAt) }

// EncodeCard validates card and returns its JSON.
func EncodeCard(card Card) ([]byte, error) {
	if err := card.Validate(); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(card)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrCardInvalid, err)
	}
	if len(raw) > MaxCardBytes {
		return nil, fmt.Errorf("%w: exceeds %d bytes", ErrCardInvalid, MaxCardBytes)
	}
	return raw, nil
}

// DecodeCard parses a card strictly: no unknown fields, no trailing data and
// every field valid. It does not reject an expired card; see Card.Expired.
func DecodeCard(raw []byte) (Card, error) {
	if len(raw) > MaxCardBytes {
		return Card{}, fmt.Errorf("%w: exceeds %d bytes", ErrCardInvalid, MaxCardBytes)
	}
	var card Card
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&card); err != nil {
		return Card{}, fmt.Errorf("%w: %w", ErrCardInvalid, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Card{}, fmt.Errorf("%w: trailing data", ErrCardInvalid)
	}
	if err := card.Validate(); err != nil {
		return Card{}, err
	}
	return card, nil
}

func usableCardCandidates(candidates []pairing.Candidate) []pairing.Candidate {
	usable := make([]pairing.Candidate, 0, min(len(candidates), MaxCardCandidates))
	seen := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		if len(usable) == MaxCardCandidates {
			break
		}
		if pairing.ValidCandidate(candidate) && !seen[candidate.Address] {
			seen[candidate.Address] = true
			usable = append(usable, candidate)
		}
	}
	return usable
}
