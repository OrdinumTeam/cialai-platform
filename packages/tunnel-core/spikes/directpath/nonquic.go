// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"tailscale.com/net/stun"
)

const (
	punchRequestPrefix = "\x00CIALAI-DIRECT-PUNCH/1 "
	punchReplyPrefix   = "\x00CIALAI-DIRECT-PUNCH-ACK/1 "
)

type stunReply struct {
	address string
	rtt     time.Duration
	err     error
}

type packetMux struct {
	transport *quic.Transport

	mu           sync.Mutex
	stunWaiting  map[stun.TxID]chan stunReply
	punchWaiting map[string]chan struct{}
	respondPunch bool
}

func newPacketMux(transport *quic.Transport, respondPunch bool) *packetMux {
	return &packetMux{
		transport:    transport,
		stunWaiting:  make(map[stun.TxID]chan stunReply),
		punchWaiting: make(map[string]chan struct{}),
		respondPunch: respondPunch,
	}
}

func (m *packetMux) run(ctx context.Context) {
	buffer := make([]byte, 64*1024)
	for {
		n, remote, err := m.transport.ReadNonQUICPacket(ctx, buffer)
		if err != nil {
			return
		}
		packet := append([]byte(nil), buffer[:n]...)
		if txID, addr, err := stun.ParseResponse(packet); err == nil {
			m.mu.Lock()
			waiting := m.stunWaiting[txID]
			delete(m.stunWaiting, txID)
			m.mu.Unlock()
			if waiting != nil {
				waiting <- stunReply{address: addr.String()}
			}
			continue
		}
		text := string(packet)
		switch {
		case strings.HasPrefix(text, punchRequestPrefix):
			if m.respondPunch {
				nonce := strings.TrimSpace(strings.TrimPrefix(text, punchRequestPrefix))
				if nonce != "" {
					_, _ = m.transport.WriteTo([]byte(punchReplyPrefix+nonce), remote)
				}
			}
		case strings.HasPrefix(text, punchReplyPrefix):
			nonce := strings.TrimSpace(strings.TrimPrefix(text, punchReplyPrefix))
			m.mu.Lock()
			waiting := m.punchWaiting[nonce]
			delete(m.punchWaiting, nonce)
			m.mu.Unlock()
			if waiting != nil {
				close(waiting)
			}
		}
	}
}

func (m *packetMux) stun(ctx context.Context, server string) stunReply {
	remote, err := net.ResolveUDPAddr("udp", server)
	if err != nil {
		return stunReply{err: err}
	}
	txID := stun.NewTxID()
	waiting := make(chan stunReply, 1)
	m.mu.Lock()
	m.stunWaiting[txID] = waiting
	m.mu.Unlock()
	started := time.Now()
	if _, err := m.transport.WriteTo(stun.Request(txID), remote); err != nil {
		m.removeSTUNWaiter(txID)
		return stunReply{err: err}
	}
	select {
	case reply := <-waiting:
		reply.rtt = time.Since(started)
		return reply
	case <-ctx.Done():
		m.removeSTUNWaiter(txID)
		return stunReply{err: ctx.Err()}
	}
}

func (m *packetMux) removeSTUNWaiter(txID stun.TxID) {
	m.mu.Lock()
	delete(m.stunWaiting, txID)
	m.mu.Unlock()
}

func (m *packetMux) punch(ctx context.Context, remote net.Addr) bool {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return false
	}
	nonce := base64.RawURLEncoding.EncodeToString(random)
	waiting := make(chan struct{})
	m.mu.Lock()
	m.punchWaiting[nonce] = waiting
	m.mu.Unlock()
	if _, err := m.transport.WriteTo([]byte(punchRequestPrefix+nonce), remote); err != nil {
		m.removePunchWaiter(nonce)
		return false
	}
	select {
	case <-waiting:
		return true
	case <-ctx.Done():
		m.removePunchWaiter(nonce)
		return false
	}
}

func (m *packetMux) removePunchWaiter(nonce string) {
	m.mu.Lock()
	delete(m.punchWaiting, nonce)
	m.mu.Unlock()
}

func punchCandidates(ctx context.Context, mux *packetMux, candidates []candidate) (sent, acknowledged int) {
	for _, item := range candidates {
		remote, err := net.ResolveUDPAddr("udp", item.Address)
		if err != nil {
			continue
		}
		sent++
		attemptCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		if mux.punch(attemptCtx, remote) {
			acknowledged++
		}
		cancel()
	}
	return sent, acknowledged
}

func isExpectedNetworkStop(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, net.ErrClosed)
}
