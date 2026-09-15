// SPDX-License-Identifier: Apache-2.0
package portmap

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const testTimeout = 10 * time.Second

// udpSocket is a wildcard UDP socket; STUN stays disabled, so no packet
// handler is needed.
type udpSocket struct{ *net.UDPConn }

func (udpSocket) HandlePackets(func([]byte, net.Addr)) {}

func noGateway() (netip.Addr, netip.Addr, bool) { return netip.Addr{}, netip.Addr{}, false }

func TestGatewayAbsentKeepsLocalCandidates(t *testing.T) {
	mapper, err := newMapper(4740, t.Logf, noGateway)
	if err != nil {
		t.Skipf("network monitor unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	services, probeErr := mapper.Probe(ctx)
	if probeErr == nil || services != (candidates.Services{}) {
		t.Fatalf("Probe without a gateway = %+v, %v", services, probeErr)
	}

	conn, err := net.ListenUDP("udp", &net.UDPAddr{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	collector, err := candidates.New(candidates.Config{
		Socket:     udpSocket{conn},
		PortMapper: mapper,
		Addresses: func() ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("192.168.1.10"), netip.MustParseAddr("2804:14d:5c21:1::10")}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(ctx); err != nil {
		t.Fatal(err)
	}
	// Give a background mapping attempt time to fail before looking again.
	time.Sleep(200 * time.Millisecond)
	snapshot := collector.Snapshot()
	if _, ok := mapper.Mapping(); ok || snapshot.Mapping.External.IsValid() || len(snapshot.Candidates) != 2 {
		t.Fatalf("snapshot without a gateway = %+v", snapshot)
	}
	for _, candidate := range snapshot.Candidates {
		if candidate.Type == pairing.CandidateMapped {
			t.Fatalf("mapped candidate without a gateway: %v", candidate)
		}
	}

	closed := make(chan error, 1)
	go func() { closed <- collector.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("Close = %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Close hung without a gateway")
	}
	if _, ok := mapper.Mapping(); ok {
		t.Fatal("Mapping after Close reported a mapping")
	}
}

func TestCloseWithoutStart(t *testing.T) {
	mapper, err := newMapper(4740, nil, noGateway)
	if err != nil {
		t.Skipf("network monitor unavailable: %v", err)
	}
	if err := mapper.Close(); err != nil {
		t.Fatal(err)
	}
	if err := mapper.Close(); err != nil {
		t.Fatalf("second Close = %v", err)
	}
}
