// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"cmp"
	"net"
	"net/netip"
	"slices"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

var (
	// sharedAddressSpace is RFC 6598, accepted as lan by the pairing rules.
	sharedAddressSpace = netip.MustParsePrefix("100.64.0.0/10")
	// routeProbes are documentation addresses: connecting a UDP socket to them
	// selects the source address of the default route without sending data.
	routeProbes = []string{"192.0.2.1:9", "[2001:db8::1]:9"}
)

// Candidate is one direct QUIC endpoint of this host.
type Candidate struct {
	// Type is pairing.CandidateLAN, CandidateIPv6, CandidateMapped or
	// CandidateSTUN.
	Type    string
	Address netip.AddrPort
	// Source is the mapping protocol or the STUN server that produced the
	// candidate; it is empty for interface addresses and never sent in the QR.
	Source string
}

// Pairing converts the candidate to the QR and reach card format.
func (candidate Candidate) Pairing() pairing.Candidate {
	return pairing.Candidate{Type: candidate.Type, Address: candidate.Address.String()}
}

// Snapshot is the state of the candidates at one moment.
type Snapshot struct {
	// Port is the local UDP port of the shared socket.
	Port uint16
	// Candidates are valid, distinct and ordered by type: lan, ipv6, mapped
	// and stun.
	Candidates []Candidate
	// Mapping is the usable gateway mapping, or the zero value.
	Mapping     Mapping
	CollectedAt time.Time
}

// Pairing returns every candidate in the QR and reach card format.
func (snapshot Snapshot) Pairing() []pairing.Candidate {
	converted := make([]pairing.Candidate, 0, len(snapshot.Candidates))
	for _, candidate := range snapshot.Candidates {
		converted = append(converted, candidate.Pairing())
	}
	return converted
}

// ForQR returns at most pairing.MaxCandidates candidates, taking one of each
// type per round in the order lan, ipv6, mapped and stun, so a host with many
// addresses of one type still offers the other paths.
func (snapshot Snapshot) ForQR() []pairing.Candidate {
	byType := make(map[string][]Candidate, len(typeOrder))
	for _, candidate := range snapshot.Candidates {
		byType[candidate.Type] = append(byType[candidate.Type], candidate)
	}
	picked := make([]pairing.Candidate, 0, pairing.MaxCandidates)
	for round := 0; len(picked) < pairing.MaxCandidates; round++ {
		added := false
		for _, kind := range typeOrder {
			if round < len(byType[kind]) && len(picked) < pairing.MaxCandidates {
				picked = append(picked, byType[kind][round].Pairing())
				added = true
			}
		}
		if !added {
			break
		}
	}
	return picked
}

// AddrPorts returns the candidate addresses, as the puncher and the dialer
// take them.
func (snapshot Snapshot) AddrPorts() []netip.AddrPort {
	addresses := make([]netip.AddrPort, 0, len(snapshot.Candidates))
	for _, candidate := range snapshot.Candidates {
		addresses = append(addresses, candidate.Address)
	}
	return addresses
}

var typeOrder = []string{pairing.CandidateLAN, pairing.CandidateIPv6, pairing.CandidateMapped, pairing.CandidateSTUN}

func typeRank(kind string) int { return slices.Index(typeOrder, kind) }

// interfaceCandidate classifies one interface address; ok is false when the
// address cannot be a lan or ipv6 candidate.
func interfaceCandidate(address netip.Addr, port uint16) (Candidate, int, bool) {
	address = address.Unmap()
	if address.Zone() != "" || address.IsLoopback() {
		return Candidate{}, 0, false
	}
	kind, class := "", 0
	switch {
	case address.Is4() && address.IsPrivate():
		kind = pairing.CandidateLAN
	case sharedAddressSpace.Contains(address):
		kind, class = pairing.CandidateLAN, 1
	case address.Is6() && address.IsPrivate():
		kind, class = pairing.CandidateLAN, 2
	case address.Is6() && address.IsGlobalUnicast():
		kind = pairing.CandidateIPv6
	default:
		return Candidate{}, 0, false
	}
	candidate := Candidate{Type: kind, Address: netip.AddrPortFrom(address, port)}
	return candidate, class, pairing.ValidCandidate(candidate.Pairing())
}

// buildCandidates merges the sources in priority order. Interface addresses
// keep the order of the address source inside each class, which puts the
// default route first; later duplicates of an address are dropped.
func buildCandidates(port uint16, addresses []netip.Addr, mapping Mapping, reflexive []Candidate) []Candidate {
	type ranked struct {
		candidate Candidate
		class     int
	}
	var local []ranked
	for _, address := range addresses {
		if candidate, class, ok := interfaceCandidate(address, port); ok {
			local = append(local, ranked{candidate: candidate, class: class})
		}
	}
	slices.SortStableFunc(local, func(a, b ranked) int {
		return cmp.Or(cmp.Compare(typeRank(a.candidate.Type), typeRank(b.candidate.Type)), cmp.Compare(a.class, b.class))
	})
	all := make([]Candidate, 0, len(local)+1+len(reflexive))
	for _, item := range local {
		all = append(all, item.candidate)
	}
	if mapping.External.IsValid() {
		all = append(all, Candidate{Type: pairing.CandidateMapped, Address: mapping.External, Source: mapping.Protocol})
	}
	all = append(all, reflexive...)

	seen := make(map[netip.AddrPort]bool, len(all))
	result := make([]Candidate, 0, len(all))
	for _, candidate := range all {
		if seen[candidate.Address] || !pairing.ValidCandidate(candidate.Pairing()) {
			continue
		}
		seen[candidate.Address] = true
		result = append(result, candidate)
	}
	return result
}

// publicEndpoint reports whether an address found by a gateway or a STUN
// server can be announced as mapped or stun.
func publicEndpoint(address netip.AddrPort) bool {
	return pairing.ValidCandidate(pairing.Candidate{Type: pairing.CandidateMapped, Address: address.String()})
}

// InterfaceAddresses lists the addresses of the interfaces that are up,
// without loopback and point-to-point tunnels, starting with the interfaces of
// the default IPv4 and IPv6 routes. It is the default Config.Addresses on the
// desktop; the phone passes the addresses reported by the operating system.
func InterfaceAddresses() ([]netip.Addr, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	defaults := defaultRouteAddresses()
	var preferred, others []netip.Addr
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		raw, err := iface.Addrs()
		if err != nil {
			continue
		}
		var found []netip.Addr
		isDefault := false
		for _, item := range raw {
			prefix, ok := item.(*net.IPNet)
			if !ok {
				continue
			}
			address, ok := netip.AddrFromSlice(prefix.IP)
			if !ok {
				continue
			}
			address = address.Unmap()
			isDefault = isDefault || slices.Contains(defaults, address)
			found = append(found, address)
		}
		if isDefault {
			preferred = append(preferred, found...)
		} else {
			others = append(others, found...)
		}
	}
	return append(preferred, others...), nil
}

func defaultRouteAddresses() []netip.Addr {
	var addresses []netip.Addr
	for _, probe := range routeProbes {
		conn, err := net.Dial("udp", probe)
		if err != nil {
			continue
		}
		if local := addrPortOf(conn.LocalAddr()); local.IsValid() {
			addresses = append(addresses, local.Addr())
		}
		_ = conn.Close()
	}
	return addresses
}
