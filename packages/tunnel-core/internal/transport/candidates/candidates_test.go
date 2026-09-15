// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"net/netip"
	"slices"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

func TestBuildCandidatesOrdersFiltersAndDeduplicates(t *testing.T) {
	addresses := []netip.Addr{
		netip.MustParseAddr("fd12:3456::10"),
		netip.MustParseAddr("2804:14d:5c21:1::10"),
		netip.MustParseAddr("100.101.102.103"),
		netip.MustParseAddr("192.168.1.10"),
		netip.MustParseAddr("127.0.0.1"),
		netip.MustParseAddr("::1"),
		netip.MustParseAddr("fe80::1"),
		netip.MustParseAddr("169.254.10.1"),
		netip.MustParseAddr("8.8.8.8"),
		netip.MustParseAddr("::ffff:10.0.0.2"),
		netip.MustParseAddr("192.168.1.10"),
		netip.MustParseAddr("224.0.0.251"),
	}
	mapping := Mapping{Protocol: "pmp", External: netip.MustParseAddrPort("203.0.113.9:40001"), GoodUntil: time.Now().Add(time.Hour)}
	reflexive := []Candidate{
		{Type: pairing.CandidateSTUN, Address: netip.MustParseAddrPort("203.0.113.9:40001"), Source: "a"},
		{Type: pairing.CandidateSTUN, Address: netip.MustParseAddrPort("198.51.100.7:5555"), Source: "b"},
	}
	got := buildCandidates(4740, addresses, mapping, reflexive)
	want := []Candidate{
		{Type: pairing.CandidateLAN, Address: netip.MustParseAddrPort("192.168.1.10:4740")},
		{Type: pairing.CandidateLAN, Address: netip.MustParseAddrPort("10.0.0.2:4740")},
		{Type: pairing.CandidateLAN, Address: netip.MustParseAddrPort("100.101.102.103:4740")},
		{Type: pairing.CandidateLAN, Address: netip.MustParseAddrPort("[fd12:3456::10]:4740")},
		{Type: pairing.CandidateIPv6, Address: netip.MustParseAddrPort("[2804:14d:5c21:1::10]:4740")},
		{Type: pairing.CandidateMapped, Address: netip.MustParseAddrPort("203.0.113.9:40001"), Source: "pmp"},
		{Type: pairing.CandidateSTUN, Address: netip.MustParseAddrPort("198.51.100.7:5555"), Source: "b"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("candidates:\n got %v\nwant %v", got, want)
	}
	for _, candidate := range got {
		if !pairing.ValidCandidate(candidate.Pairing()) {
			t.Fatalf("candidate %v is not valid for the QR", candidate)
		}
	}
}

func TestBuildCandidatesDropsPrivateGatewayAddresses(t *testing.T) {
	mapping := Mapping{Protocol: "upnp", External: netip.MustParseAddrPort("10.0.0.5:4740"), GoodUntil: time.Now().Add(time.Hour)}
	reflexive := []Candidate{{Type: pairing.CandidateSTUN, Address: netip.MustParseAddrPort("192.168.0.2:4740")}}
	if got := buildCandidates(4740, nil, mapping, reflexive); len(got) != 0 {
		t.Fatalf("private mapped and reflected addresses must be dropped, got %v", got)
	}
}

func TestForQRAlternatesTypesWithinTheLimit(t *testing.T) {
	snapshot := Snapshot{Candidates: buildCandidates(4740, []netip.Addr{
		netip.MustParseAddr("192.168.1.10"),
		netip.MustParseAddr("192.168.2.10"),
		netip.MustParseAddr("10.1.1.1"),
		netip.MustParseAddr("2804:14d:5c21:1::10"),
		netip.MustParseAddr("2804:14d:5c21:1::11"),
		netip.MustParseAddr("2804:14d:5c21:1::12"),
	}, Mapping{Protocol: "pcp", External: netip.MustParseAddrPort("203.0.113.9:40001"), GoodUntil: time.Now().Add(time.Hour)},
		[]Candidate{{Type: pairing.CandidateSTUN, Address: netip.MustParseAddrPort("198.51.100.7:5555")}})}
	got := snapshot.ForQR()
	want := []pairing.Candidate{
		{Type: pairing.CandidateLAN, Address: "192.168.1.10:4740"},
		{Type: pairing.CandidateIPv6, Address: "[2804:14d:5c21:1::10]:4740"},
		{Type: pairing.CandidateMapped, Address: "203.0.113.9:40001"},
		{Type: pairing.CandidateSTUN, Address: "198.51.100.7:5555"},
		{Type: pairing.CandidateLAN, Address: "192.168.2.10:4740"},
		{Type: pairing.CandidateIPv6, Address: "[2804:14d:5c21:1::11]:4740"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("ForQR:\n got %v\nwant %v", got, want)
	}
	if len(snapshot.Pairing()) != 8 || len(snapshot.AddrPorts()) != 8 {
		t.Fatalf("Pairing and AddrPorts must keep every candidate")
	}
	if few := (Snapshot{Candidates: snapshot.Candidates[:2]}).ForQR(); len(few) != 2 {
		t.Fatalf("ForQR with two candidates = %v", few)
	}
}

func TestInterfaceAddressesSkipsLoopback(t *testing.T) {
	addresses, err := InterfaceAddresses()
	if err != nil {
		t.Skipf("interfaces unavailable: %v", err)
	}
	for _, address := range addresses {
		if address.IsLoopback() {
			t.Fatalf("loopback address %s listed", address)
		}
	}
}
