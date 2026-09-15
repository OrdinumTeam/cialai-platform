// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
)

type approvalQueue struct {
	mu      sync.Mutex
	pending map[string]chan bool
	emit    func(string, any)
}

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
		code = leftPadCode(value.Int64())
	}
	queue.emit("pair.requested", map[string]any{"pairId": request.PairID, "device": request.Device, "code": code, "until": request.Until})
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

func leftPadCode(value int64) string {
	return fmt.Sprintf("%04d", value)
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
