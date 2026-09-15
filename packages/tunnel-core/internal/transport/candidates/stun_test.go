// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"context"
	"crypto/rand"
	"net"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

var _ Socket = (*direct.Endpoint)(nil)

func TestSTUNReflectsThroughTheQUICSocket(t *testing.T) {
	desktop, err := identity.Generate(identity.RoleDesktop, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: conn, Identity: desktop})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	server := newSTUNServer(t, "203.0.113.7:40000")
	collector := newTestCollector(t, Config{Socket: endpoint, STUNServers: []string{server.address()}})

	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	snapshot, err := collector.Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !hasCandidate(snapshot, pairing.CandidateSTUN, "203.0.113.7:40000") {
		t.Fatalf("snapshot %v lacks the reflected address", snapshot.Candidates)
	}
	if snapshot.Candidates[len(snapshot.Candidates)-1].Source != server.address() {
		t.Fatalf("stun candidate source = %q", snapshot.Candidates[len(snapshot.Candidates)-1].Source)
	}
	quicPort := endpoint.LocalAddr().(*net.UDPAddr).Port
	for _, source := range server.seenSources() {
		if int(source.Port()) != quicPort {
			t.Fatalf("STUN request came from port %d, want the QUIC port %d", source.Port(), quicPort)
		}
	}
}

func TestSTUNRetransmitsWithinTheDeadline(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	server.drop.Store(1)
	client := newSTUNClient(socket, []string{server.address()}, DefaultSTUNTimeout, true, t.Logf)
	socket.HandlePackets(client.handle)

	started := time.Now()
	reflected := client.query(context.Background())
	elapsed := time.Since(started)
	if len(reflected) != 1 || reflected[0].Address.String() != "203.0.113.7:40000" || reflected[0].Type != pairing.CandidateSTUN {
		t.Fatalf("reflected = %v", reflected)
	}
	if server.requests.Load() != 2 || elapsed < stunInitialRetransmit || elapsed >= DefaultSTUNTimeout {
		t.Fatalf("requests = %d after %v, want one retransmission within the deadline", server.requests.Load(), elapsed)
	}
}

func TestSTUNSilentServerKeepsLocalCandidatesAndDeadline(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	server := newSTUNServer(t, "203.0.113.7:40000")
	server.silent.Store(true)
	collector := newTestCollector(t, Config{
		Socket: socket, STUNServers: []string{server.address()}, STUNTimeout: 300 * time.Millisecond,
		Addresses: staticAddresses("192.168.1.10", "2804:14d:5c21:1::10"),
	})

	started := time.Now()
	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	if elapsed < 250*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("collect took %v with a 300 ms STUN deadline", elapsed)
	}
	if countType(snapshot, pairing.CandidateSTUN) != 0 || !hasCandidate(snapshot, pairing.CandidateLAN, "192.168.1.10:4740") ||
		!hasCandidate(snapshot, pairing.CandidateIPv6, "[2804:14d:5c21:1::10]:4740") {
		t.Fatalf("snapshot = %v", snapshot.Candidates)
	}
}

func TestSTUNIgnoresSpoofedAndPrivateReplies(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	spoofed := newSTUNServer(t, "203.0.113.66:1111")
	other, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	spoofed.spoof.Store(other)
	private := newSTUNServer(t, "192.168.0.1:4740")
	collector := newTestCollector(t, Config{
		Socket: socket, STUNServers: []string{spoofed.address(), private.address()}, STUNTimeout: 300 * time.Millisecond,
		Addresses: staticAddresses("192.168.1.10"),
	})

	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if countType(snapshot, pairing.CandidateSTUN) != 0 {
		t.Fatalf("spoofed or private replies accepted: %v", snapshot.Candidates)
	}
	if spoofed.requests.Load() == 0 || private.requests.Load() == 0 {
		t.Fatalf("both servers must be asked")
	}
}

func TestSTUNDisabledByDefault(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	collector := newTestCollector(t, Config{Socket: socket, Addresses: staticAddresses("192.168.1.10")})
	snapshot, err := collector.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if socket.hasHandler() || socket.writes.Load() != 0 {
		t.Fatalf("collector without STUN servers touched the socket")
	}
	if len(snapshot.Candidates) != 1 {
		t.Fatalf("snapshot = %v", snapshot.Candidates)
	}
}

func TestSTUNServerListIsValidated(t *testing.T) {
	socket := newFakeSocket(t, "[::]:4740")
	for _, server := range []string{"stun.example.com", ":3478", "stun.example.com:0", "stun.example.com:x"} {
		if _, err := New(Config{Socket: socket, STUNServers: []string{server}}); err == nil {
			t.Fatalf("server %q accepted", server)
		}
	}
}
