// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"io"
	"sync"
	"time"
)

const MaxSecretFailures = 10

type ActiveSession struct {
	PairID       string    `json:"pairId"`
	Payload      string    `json:"payload"`
	ExpiresAt    time.Time `json:"expiresAt"`
	PreAuthKeyID uint64    `json:"preAuthKeyId"`
}

type ConsumedSession struct {
	PairID       string
	ExpiresAt    time.Time
	PreAuthKeyID uint64
	UserID       string
	UserName     string
	Desktop      Desktop
}

type session struct {
	secret       []byte
	expiresAt    time.Time
	preAuthKeyID uint64
	userID       string
	userName     string
	desktop      Desktop
	consumed     bool
	failures     int
}

type Sessions struct {
	mu        sync.Mutex
	now       func() time.Time
	random    io.Reader
	allowHTTP bool
	items     map[string]*session
}

func NewSessions(now func() time.Time, random io.Reader, allowLoopbackHTTP bool) *Sessions {
	if now == nil {
		now = time.Now
	}
	if random == nil {
		random = rand.Reader
	}
	return &Sessions{now: now, random: random, allowHTTP: allowLoopbackHTTP, items: make(map[string]*session)}
}

func (sessions *Sessions) Begin(template Payload, preAuthKeyID uint64, ttl time.Duration) (ActiveSession, error) {
	if preAuthKeyID == 0 || ttl <= 0 || ttl > 10*time.Minute {
		return ActiveSession{}, NewError("payload_invalid", "A validade da sessão de pareamento é inválida.")
	}
	secret := make([]byte, 32)
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if _, err := io.ReadFull(sessions.random, secret); err != nil {
		return ActiveSession{}, wrapError("pair_internal", "Não foi possível criar o segredo de pareamento.", err)
	}
	pairID, err := sessions.uniquePairIDLocked()
	if err != nil {
		return ActiveSession{}, err
	}
	expiresAt := sessions.now().Add(ttl).UTC()
	template.Version = 1
	template.Secret = base64.RawURLEncoding.EncodeToString(secret)
	template.PairID = pairID
	template.ExpiresAt = expiresAt.Unix()
	payload, err := Encode(template, sessions.allowHTTP)
	if err != nil {
		return ActiveSession{}, err
	}
	sessions.items[pairID] = &session{
		secret: secret, expiresAt: expiresAt, preAuthKeyID: preAuthKeyID,
		userID: template.UserID, userName: template.UserName, desktop: template.Desktop,
	}
	return ActiveSession{PairID: pairID, Payload: payload, ExpiresAt: expiresAt, PreAuthKeyID: preAuthKeyID}, nil
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

func (sessions *Sessions) Consume(pairID, encodedSecret string) (ConsumedSession, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	current, err := sessions.checkLocked(pairID, encodedSecret, true)
	if err != nil {
		return ConsumedSession{}, err
	}
	current.consumed = true
	return sessionResult(pairID, current), nil
}

// Verify authenticates a request without consuming it. The edge calls this
// before WhoIs and approval, then Consume atomically wins against any replay.
func (sessions *Sessions) Verify(pairID, encodedSecret string) (ConsumedSession, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	current, err := sessions.checkLocked(pairID, encodedSecret, true)
	if err != nil {
		return ConsumedSession{}, err
	}
	return sessionResult(pairID, current), nil
}

func (sessions *Sessions) checkLocked(pairID, encodedSecret string, countFailure bool) (*session, error) {
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
		if countFailure && current.failures < MaxSecretFailures {
			current.failures++
		}
		return nil, NewError("pair_secret_mismatch", "O segredo de pareamento não confere.")
	}
	return current, nil
}

func sessionResult(pairID string, current *session) ConsumedSession {
	return ConsumedSession{
		PairID: pairID, ExpiresAt: current.expiresAt, PreAuthKeyID: current.preAuthKeyID,
		UserID: current.userID, UserName: current.userName, Desktop: current.desktop,
	}
}

func (sessions *Sessions) Cancel(pairID string) (uint64, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	current, exists := sessions.items[pairID]
	if !exists {
		return 0, NewError("pair_unknown", "O pareamento já não está ativo.")
	}
	delete(sessions.items, pairID)
	return current.preAuthKeyID, nil
}
