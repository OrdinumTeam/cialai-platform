// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"bytes"
	"context"
	"crypto/rand"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

// Opening packets are 25 bytes: an 8-byte magic whose first byte is zero, so
// quic-go hands them to ReadNonQUICPacket, a kind byte and a 16-byte nonce.
// Answers have the same size as requests, so they cannot amplify traffic.
const (
	openingPacketSize  = 25
	openingRequest     = 0x01
	openingAnswer      = 0x02
	maxNonQUICPacket   = 2048
	punchInterval      = 200 * time.Millisecond
	punchMaxRounds     = 10
	openingMagicLength = 8
)

var openingMagic = [openingMagicLength]byte{0x00, 'C', 'I', 'A', 'L', 'A', 'I', 0x01}

type punchWaiter struct {
	index   int
	answers chan<- int
}

type packetMux struct {
	transport *quic.Transport
	handler   atomic.Pointer[func([]byte, net.Addr)]

	mu      sync.Mutex
	waiting map[[16]byte]punchWaiter
}

func newPacketMux(quicTransport *quic.Transport) *packetMux {
	return &packetMux{transport: quicTransport, waiting: make(map[[16]byte]punchWaiter)}
}

func (mux *packetMux) setHandler(handler func([]byte, net.Addr)) {
	if handler == nil {
		mux.handler.Store(nil)
		return
	}
	mux.handler.Store(&handler)
}

func (mux *packetMux) run(ctx context.Context) {
	buffer := make([]byte, maxNonQUICPacket)
	for {
		n, from, err := mux.transport.ReadNonQUICPacket(ctx, buffer)
		if err != nil {
			return
		}
		packet := buffer[:n]
		if kind, nonce, ok := parseOpening(packet); ok {
			mux.handleOpening(kind, nonce, from)
			continue
		}
		if handler := mux.handler.Load(); handler != nil {
			(*handler)(packet, from)
		}
	}
}

func (mux *packetMux) handleOpening(kind byte, nonce [16]byte, from net.Addr) {
	switch kind {
	case openingRequest:
		_, _ = mux.transport.WriteTo(openingPacket(openingAnswer, nonce), from)
	case openingAnswer:
		mux.mu.Lock()
		waiter, ok := mux.waiting[nonce]
		delete(mux.waiting, nonce)
		mux.mu.Unlock()
		if ok {
			waiter.answers <- waiter.index
		}
	}
}

// punch retransmits opening packets to unanswered targets every
// punchInterval, for at most punchMaxRounds rounds or until ctx ends.
func (mux *packetMux) punch(ctx context.Context, targets []netip.AddrPort) (transport.PunchReport, error) {
	report := transport.PunchReport{}
	answers := make(chan int, len(targets))
	nonces := make([][16]byte, len(targets))
	mux.mu.Lock()
	for index := range targets {
		if _, err := rand.Read(nonces[index][:]); err != nil {
			mux.mu.Unlock()
			return report, err
		}
		mux.waiting[nonces[index]] = punchWaiter{index: index, answers: answers}
	}
	mux.mu.Unlock()
	defer func() {
		mux.mu.Lock()
		for _, nonce := range nonces {
			delete(mux.waiting, nonce)
		}
		mux.mu.Unlock()
	}()

	answered := make([]bool, len(targets))
	ticker := time.NewTicker(punchInterval)
	defer ticker.Stop()
	for round := 0; round < punchMaxRounds && len(report.Acknowledged) < len(targets); round++ {
		for index, target := range targets {
			if answered[index] {
				continue
			}
			if _, err := mux.transport.WriteTo(openingPacket(openingRequest, nonces[index]), net.UDPAddrFromAddrPort(target)); err == nil {
				report.Sent++
			}
		}
		if !mux.collect(ctx, ticker.C, answers, answered, targets, &report) {
			break
		}
	}
	return report, nil
}

// collect records answers until the next round is due; it returns false when
// ctx ended or every target answered.
func (mux *packetMux) collect(ctx context.Context, tick <-chan time.Time, answers <-chan int, answered []bool, targets []netip.AddrPort, report *transport.PunchReport) bool {
	for {
		select {
		case index := <-answers:
			if !answered[index] {
				answered[index] = true
				report.Acknowledged = append(report.Acknowledged, targets[index])
			}
			if len(report.Acknowledged) == len(targets) {
				return false
			}
		case <-tick:
			return true
		case <-ctx.Done():
			return false
		}
	}
}

func openingPacket(kind byte, nonce [16]byte) []byte {
	packet := make([]byte, 0, openingPacketSize)
	packet = append(packet, openingMagic[:]...)
	packet = append(packet, kind)
	return append(packet, nonce[:]...)
}

func parseOpening(packet []byte) (byte, [16]byte, bool) {
	var nonce [16]byte
	if len(packet) != openingPacketSize || !bytes.Equal(packet[:openingMagicLength], openingMagic[:]) {
		return 0, nonce, false
	}
	kind := packet[openingMagicLength]
	if kind != openingRequest && kind != openingAnswer {
		return 0, nonce, false
	}
	copy(nonce[:], packet[openingMagicLength+1:])
	return kind, nonce, true
}
