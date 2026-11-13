// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"strings"
	"time"
)

const BrotoPrefix = "CIALAIB2."

func DecodeBroto(code string) (Payload, error) {
	if !strings.HasPrefix(code, BrotoPrefix) {
		return Payload{}, NewError("payload_invalid", "Código de Broto inválido.")
	}
	return Decode(Prefix + strings.TrimPrefix(code, BrotoPrefix))
}

type BrotoPending struct {
	PairID    string    `json:"pairId"`
	Name      string    `json:"name"`
	Platform  string    `json:"platform"`
	Digits    string    `json:"digits"`
	ExpiresAt time.Time `json:"expiresAt"`
	Key       string    `json:"-"`
}

func (s *Sessions) BeginBroto(p Payload) (ActiveSession, error) {
	return s.begin(p, MaxSessionTTL, true)
}

// PollBroto binds a code to its first authenticated key. The callback runs
// once, under the session lock, only after an explicit local approval.
func (s *Sessions) PollBroto(id, secret string, input DeviceInput, finish func() error) (bool, error) {
	input.Kind = identity.RoleBroto
	if _, err := validateDeviceInput(input); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.checkLocked(id, secret)
	if err != nil {
		return false, err
	}
	if !current.broto {
		return false, NewError("pair_role", "Use um código de Broto.")
	}
	if current.claim == nil {
		key, _ := identity.ParsePublicKey(input.DeviceKey)
		current.claim = &BrotoPending{PairID: id, Name: input.Name, Platform: input.Platform, Digits: ApprovalCode(id, key), ExpiresAt: current.expiresAt, Key: input.DeviceKey}
	}
	if current.claim.Key != input.DeviceKey {
		return false, NewError("pair_claimed", "Este código já pertence a outro aparelho.")
	}
	if !current.approved {
		return false, nil
	}
	if err := finish(); err != nil {
		return false, err
	}
	current.consumed = true
	return true, nil
}

func (s *Sessions) PendingBrotos() []BrotoPending {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := []BrotoPending{}
	for _, c := range s.items {
		if c.broto && c.claim != nil && !c.consumed && s.now().Before(c.expiresAt) {
			list = append(list, *c.claim)
		}
	}
	return list
}

func (s *Sessions) DecideBroto(id string, approve bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.items[id]
	if c == nil || !c.broto || c.claim == nil || c.consumed || !s.now().Before(c.expiresAt) {
		return NewError("pair_unknown", "Pedido não encontrado.")
	}
	if approve {
		c.approved = true
	} else {
		c.consumed = true
	}
	return nil
}
