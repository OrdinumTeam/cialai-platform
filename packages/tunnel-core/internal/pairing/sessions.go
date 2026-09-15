// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"time"
)

const (
	MaxSecretFailures = 10
	DefaultSessionTTL = 600 * time.Second
	MaxSessionTTL     = 10 * time.Minute
	// Finished sessions stay known this long after expiring so a replay is
	// reported as consumed or expired instead of unknown, then are dropped.
	sessionRetention = MaxSessionTTL
)

type ActiveSession struct {
	PairID    string    `json:"pairId"`
	Payload   string    `json:"payload"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type ConsumedSession struct {
	PairID    string
	ExpiresAt time.Time
	Desktop   Desktop
}

type session struct {
	secret    []byte
	expiresAt time.Time
	desktop   Desktop
	consumed  bool
	failures  int
}

// Sessions holds the one-use pairing authorizations. No Headscale pre-auth key
// exists any more: possession of the QR secret plus the phone's TLS key is the
// whole authorization.
type Sessions struct {
	mu     sync.Mutex
	now    func() time.Time
	random io.Reader
	items  map[string]*session
}

func NewSessions(now func() time.Time, random io.Reader) *Sessions {
	if now == nil {
		now = time.Now
	}
	if random == nil {
		random = rand.Reader
	}
	return &Sessions{now: now, random: random, items: make(map[string]*session)}
}

// Begin creates a session and its QR payload. The template supplies the desktop
// identity, the onion address and the direct candidates in priority order.
// Candidates come from network discovery, so invalid or repeated ones are
// skipped instead of failing the pairing; the ones beyond MaxCandidates, and
// then the lowest priority ones that do not fit in MaxJSONBytes, are left out
// because the onion is always present.
func (sessions *Sessions) Begin(template Payload, ttl time.Duration) (ActiveSession, error) {
	if ttl <= 0 || ttl > MaxSessionTTL {
		return ActiveSession{}, NewError("payload_invalid", "A validade da sessão de pareamento é inválida.")
	}
	template.Candidates = usableCandidates(template.Candidates)
	secret := make([]byte, 32)
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	now := sessions.now()
	sessions.pruneLocked(now)
	if _, err := io.ReadFull(sessions.random, secret); err != nil {
		return ActiveSession{}, wrapError("pair_internal", "Não foi possível criar o segredo de pareamento.", err)
	}
	pairID, err := sessions.uniquePairIDLocked()
	if err != nil {
		return ActiveSession{}, err
	}
	expiresAt := now.Add(ttl).UTC()
	template.Version = PayloadVersion
	template.Secret = base64.RawURLEncoding.EncodeToString(secret)
	template.PairID = pairID
	template.ExpiresAt = expiresAt.Unix()
	payload, err := Encode(template)
	for errors.Is(err, errPayloadTooLarge) && len(template.Candidates) > 0 {
		template.Candidates = template.Candidates[:len(template.Candidates)-1]
		payload, err = Encode(template)
	}
	if err != nil {
		return ActiveSession{}, err
	}
	sessions.items[pairID] = &session{secret: secret, expiresAt: expiresAt, desktop: template.Desktop}
	return ActiveSession{PairID: pairID, Payload: payload, ExpiresAt: expiresAt}, nil
}

// usableCandidates returns a new list with the first MaxCandidates valid and
// distinct candidates, keeping the caller's priority order.
func usableCandidates(candidates []Candidate) []Candidate {
	usable := make([]Candidate, 0, MaxCandidates)
	seen := make(map[string]bool, MaxCandidates)
	for _, candidate := range candidates {
		if len(usable) == MaxCandidates {
			break
		}
		if validCandidate(candidate) && !seen[candidate.Address] {
			seen[candidate.Address] = true
			usable = append(usable, candidate)
		}
	}
	return usable
}

func (sessions *Sessions) pruneLocked(now time.Time) {
	for pairID, current := range sessions.items {
		if now.After(current.expiresAt.Add(sessionRetention)) {
			delete(sessions.items, pairID)
		}
	}
}

func (sessions *Sessions) uniquePairIDLocked() (string, error) {
	for range 8 {
		pairID, err := randomEncoded(sessions.random, "p_", 8)
		if err != nil {
			return "", wrapError("pair_internal", "Não foi possível criar a sessão de pareamento.", err)
		}
		if _, exists := sessions.items[pairID]; !exists {
			return pairID, nil
		}
	}
	return "", NewError("pair_internal", "Não foi possível criar uma sessão de pareamento única.")
}

// PairingActive reports whether at least one session can still be consumed:
// not consumed, not expired and not blocked by repeated secret failures. The
// direct transport admits unregistered phone keys only while this is true.
func (sessions *Sessions) PairingActive() bool {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	now := sessions.now()
	for _, current := range sessions.items {
		if !current.consumed && now.Before(current.expiresAt) && current.failures < MaxSecretFailures {
			return true
		}
	}
	return false
}

// Consume authenticates and consumes a session atomically: exactly one caller
// wins, every replay afterwards gets pair_consumed.
func (sessions *Sessions) Consume(pairID, encodedSecret string) (ConsumedSession, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	current, err := sessions.checkLocked(pairID, encodedSecret)
	if err != nil {
		return ConsumedSession{}, err
	}
	current.consumed = true
	return sessionResult(pairID, current), nil
}

// Verify authenticates a request without consuming it. The edge calls this
// before the optional approval, then Consume atomically wins against a replay.
func (sessions *Sessions) Verify(pairID, encodedSecret string) (ConsumedSession, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	current, err := sessions.checkLocked(pairID, encodedSecret)
	if err != nil {
		return ConsumedSession{}, err
	}
	return sessionResult(pairID, current), nil
}

func (sessions *Sessions) checkLocked(pairID, encodedSecret string) (*session, error) {
	presented, decodeErr := base64.RawURLEncoding.DecodeString(encodedSecret)
	current, exists := sessions.items[pairID]
	if !exists {
		return nil, NewError("pair_unknown", "O pareamento foi cancelado no computador.")
	}
	if current.consumed {
		return nil, NewError("pair_consumed", "Este código de pareamento já foi usado.")
	}
	if !sessions.now().Before(current.expiresAt) {
		return nil, NewError("pair_expired", "Este código de pareamento expirou.")
	}
	if current.failures >= MaxSecretFailures || decodeErr != nil || len(presented) != len(current.secret) || subtle.ConstantTimeCompare(presented, current.secret) != 1 {
		if current.failures < MaxSecretFailures {
			current.failures++
		}
		return nil, NewError("pair_secret_mismatch", "O segredo de pareamento não confere.")
	}
	return current, nil
}

func sessionResult(pairID string, current *session) ConsumedSession {
	return ConsumedSession{PairID: pairID, ExpiresAt: current.expiresAt, Desktop: current.desktop}
}

func (sessions *Sessions) Cancel(pairID string) error {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if _, exists := sessions.items[pairID]; !exists {
		return NewError("pair_unknown", "O pareamento já não está ativo.")
	}
	delete(sessions.items, pairID)
	return nil
}
