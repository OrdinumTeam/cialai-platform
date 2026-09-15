// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

// approvalQueue asks the desktop to confirm pairings when approval is
// required: pair.requested shows a four digit code and pair.approve or
// pair.deny answers it.
type approvalQueue struct {
	mu      sync.Mutex
	pending map[string]chan bool
	emit    func(string, any)
}

var _ edge.Approver = (*approvalQueue)(nil)

func newApprovalQueue(emit func(string, any)) *approvalQueue {
	return &approvalQueue{pending: make(map[string]chan bool), emit: emit}
}

func (queue *approvalQueue) Await(ctx context.Context, request edge.ApprovalRequest) error {
	decision := make(chan bool, 1)
	queue.mu.Lock()
	if _, exists := queue.pending[request.PairID]; exists {
		queue.mu.Unlock()
		return pairing.NewError("pair_denied", "Já existe uma aprovação pendente para este código.")
	}
	queue.pending[request.PairID] = decision
	queue.mu.Unlock()
	defer func() {
		queue.mu.Lock()
		delete(queue.pending, request.PairID)
		queue.mu.Unlock()
	}()
	code := "0000"
	if value, err := rand.Int(rand.Reader, big.NewInt(10000)); err == nil {
		code = fmt.Sprintf("%04d", value.Int64())
	}
	fingerprint := ""
	if public, err := identity.ParsePublicKey(request.Device.PublicKey); err == nil {
		fingerprint = identity.Fingerprint(public)
	}
	queue.emit("pair.requested", map[string]any{
		"pairId": request.PairID, "device": request.Device, "fingerprint": fingerprint,
		"transport": request.Transport, "code": code, "until": request.Until,
	})
	select {
	case approved := <-decision:
		if !approved {
			return pairing.NewError("pair_denied", "O pareamento foi recusado no computador.")
		}
		return nil
	case <-ctx.Done():
		return pairing.NewError("pair_timeout", "O computador não respondeu ao pedido de pareamento.")
	}
}

func (queue *approvalQueue) resolve(pairID string, approved bool) bool {
	queue.mu.Lock()
	decision := queue.pending[pairID]
	queue.mu.Unlock()
	if decision == nil {
		return false
	}
	select {
	case decision <- approved:
		return true
	default:
		return false
	}
}
