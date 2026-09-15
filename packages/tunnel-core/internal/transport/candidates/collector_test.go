// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

func TestMappingSkipsSTUNAndIsRenewedBeforeItEnds(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	mapper := &fakeMapper{lifetime: 600 * time.Millisecond, renew: true, protocol: "pmp", external: netip.MustParseAddrPort("198.51.100.20:61000")}
	recorder := newChangeRecorder()
	collector := newTestCollector(t, Config{
		Socket: socket, STUNServers: []string{server.address()}, PortMapper: mapper,
		Addresses: staticAddresses("192.168.1.10"), OnChange: recorder.onChange,
	})

	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !hasCandidate(snapshot, pairing.CandidateMapped, "198.51.100.20:61000") || snapshot.Mapping.Protocol != "pmp" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	// Watch three lifetimes: the mapped candidate must never disappear.
	deadline := time.Now().Add(3 * mapper.lifetime)
	for time.Now().Before(deadline) {
		if current := collector.Snapshot(); !hasCandidate(current, pairing.CandidateMapped, "198.51.100.20:61000") {
			t.Fatalf("mapped candidate lost while renewals were possible: %v", current.Candidates)
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, renewals, late := mapper.stats()
	if renewals < 3 || late {
		t.Fatalf("renewals = %d, late = %v; want renewals before each lease ended", renewals, late)
	}
	if server.requests.Load() != 0 {
		t.Fatalf("STUN asked %d times while a mapping existed", server.requests.Load())
	}
}

func TestExpiredMappingIsDroppedAndSTUNTakesOver(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	mapper := &fakeMapper{lifetime: 300 * time.Millisecond, protocol: "upnp", external: netip.MustParseAddrPort("198.51.100.20:61000")}
	recorder := newChangeRecorder()
	newTestCollector(t, Config{
		Socket: socket, STUNServers: []string{server.address()}, PortMapper: mapper,
		Addresses: staticAddresses("192.168.1.10"), OnChange: recorder.onChange,
	})

	recorder.waitFor(t, "the mapped candidate", func(snapshot Snapshot) bool {
		return hasCandidate(snapshot, pairing.CandidateMapped, "198.51.100.20:61000")
	})
	recorder.waitFor(t, "the mapping to expire and STUN to reflect", func(snapshot Snapshot) bool {
		return countType(snapshot, pairing.CandidateMapped) == 0 && hasCandidate(snapshot, pairing.CandidateSTUN, "203.0.113.7:40000") &&
			hasCandidate(snapshot, pairing.CandidateLAN, "192.168.1.10:4740")
	})
}

func TestMappingBehindSecondNATIsIgnored(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	mapper := &fakeMapper{lifetime: time.Hour, protocol: "upnp", external: netip.MustParseAddrPort("10.0.0.5:4740")}
	collector := newTestCollector(t, Config{
		Socket: socket, STUNServers: []string{server.address()}, PortMapper: mapper, Addresses: staticAddresses("192.168.1.10"),
	})

	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if countType(snapshot, pairing.CandidateMapped) != 0 || snapshot.Mapping.External.IsValid() || !hasCandidate(snapshot, pairing.CandidateSTUN, "203.0.113.7:40000") {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestNetworkChangeRecollectsAndForgetsReflectedAddresses(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	var mu sync.Mutex
	addresses := []netip.Addr{netip.MustParseAddr("192.168.1.10")}
	recorder := newChangeRecorder()
	collector := newTestCollector(t, Config{
		Socket: socket, STUNServers: []string{server.address()}, OnChange: recorder.onChange,
		Addresses: func() ([]netip.Addr, error) {
			mu.Lock()
			defer mu.Unlock()
			return append([]netip.Addr(nil), addresses...), nil
		},
	})
	recorder.waitFor(t, "the first network", func(snapshot Snapshot) bool {
		return hasCandidate(snapshot, pairing.CandidateSTUN, "203.0.113.7:40000")
	})

	mu.Lock()
	addresses = []netip.Addr{netip.MustParseAddr("10.20.30.40"), netip.MustParseAddr("2804:14d:5c21:1::10")}
	mu.Unlock()
	server.setReflected("203.0.113.8:40001")
	collector.NetworkChanged()
	snapshot := recorder.waitFor(t, "the new network", func(snapshot Snapshot) bool {
		return hasCandidate(snapshot, pairing.CandidateSTUN, "203.0.113.8:40001")
	})
	if hasCandidate(snapshot, pairing.CandidateSTUN, "203.0.113.7:40000") || hasCandidate(snapshot, pairing.CandidateLAN, "192.168.1.10:4740") ||
		!hasCandidate(snapshot, pairing.CandidateLAN, "10.20.30.40:4740") || !hasCandidate(snapshot, pairing.CandidateIPv6, "[2804:14d:5c21:1::10]:4740") {
		t.Fatalf("snapshot after the change = %v", snapshot.Candidates)
	}
}

func TestMapperNetworkEventTriggersCollection(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	mapper := &fakeMapper{lifetime: time.Hour}
	var mu sync.Mutex
	address := "192.168.1.10"
	recorder := newChangeRecorder()
	newTestCollector(t, Config{
		Socket: socket, PortMapper: mapper, OnChange: recorder.onChange,
		Addresses: func() ([]netip.Addr, error) {
			mu.Lock()
			defer mu.Unlock()
			return []netip.Addr{netip.MustParseAddr(address)}, nil
		},
	})
	recorder.waitFor(t, "the first snapshot", func(snapshot Snapshot) bool { return len(snapshot.Candidates) == 1 })
	mu.Lock()
	address = "192.168.50.2"
	mu.Unlock()
	mapper.mu.Lock()
	notify := mapper.notify
	mapper.mu.Unlock()
	notify(NetworkChanged)
	recorder.waitFor(t, "the new address", func(snapshot Snapshot) bool {
		return hasCandidate(snapshot, pairing.CandidateLAN, "192.168.50.2:4740")
	})
}

func TestIPv4SocketSkipsIPv6Addresses(t *testing.T) {
	socket := newFakeSocket(t, "0.0.0.0:4740")
	collector := newTestCollector(t, Config{Socket: socket, Addresses: staticAddresses("192.168.1.10", "2804:14d:5c21:1::10", "fd00::1")})
	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Candidates) != 1 || !hasCandidate(snapshot, pairing.CandidateLAN, "192.168.1.10:4740") || snapshot.Port != 4740 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestAddressSourceSliceIsNotModified(t *testing.T) {
	socket := newFakeSocket(t, "0.0.0.0:4740")
	source := []netip.Addr{netip.MustParseAddr("2804:14d:5c21:1::10"), netip.MustParseAddr("192.168.1.10")}
	want := append([]netip.Addr(nil), source...)
	collector := newTestCollector(t, Config{Socket: socket, Addresses: func() ([]netip.Addr, error) { return source, nil }})
	for range 2 {
		snapshot, err := collector.Collect(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Candidates) != 1 {
			t.Fatalf("snapshot = %v", snapshot.Candidates)
		}
	}
	if source[0] != want[0] || source[1] != want[1] {
		t.Fatalf("address source slice modified: %v", source)
	}
}

func TestClosedCollector(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	collector, err := New(Config{Socket: socket, STUNServers: []string{server.address()}, Addresses: staticAddresses("192.168.1.10")})
	if err != nil {
		t.Fatal(err)
	}
	if !socket.hasHandler() {
		t.Fatal("STUN handler not installed")
	}
	if err := collector.Close(); err != nil {
		t.Fatal(err)
	}
	if err := collector.Close(); err != nil {
		t.Fatalf("second Close = %v", err)
	}
	if socket.hasHandler() {
		t.Fatal("STUN handler left on the socket")
	}
	if _, err := collector.Collect(context.Background()); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("Collect after Close = %v", err)
	}
	collector.NetworkChanged()
}

func TestNewRequiresABoundSocket(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("nil socket accepted")
	}
	socket := newFakeSocket(t, "[::]:0")
	if _, err := New(Config{Socket: socket}); err == nil {
		t.Fatal("socket without port accepted")
	}
}
