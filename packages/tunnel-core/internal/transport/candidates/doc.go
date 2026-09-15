// SPDX-License-Identifier: Apache-2.0
// Package candidates collects and renews the direct QUIC endpoints of this
// host and builds the reach card. The candidates feed the pairing QR, the reach
// card delivered at the end of pairing and the fresh candidates exchanged on
// the control channel before a NAT punch.
//
// # Sources
//
// All candidates point at the UDP socket shared with the QUIC endpoint, so the
// phone dials the same port the listener, the dialer and the puncher use.
//
//   - lan: private IPv4, shared address space 100.64.0.0/10 and IPv6 ULA
//     addresses of the interfaces that are up, skipping loopback and
//     point-to-point tunnels such as VPNs.
//   - ipv6: global IPv6 addresses of the same interfaces.
//   - mapped: the port mapped on the gateway by PCP, NAT-PMP or UPnP through
//     a PortMapper. The portmap subpackage implements it with
//     tailscale.com/net/portmapper and lives apart because it adds about
//     2.8 MiB to a binary that already links net/http; the phone uses this
//     package without it. The collector asks for renewal at half of the
//     remaining lease, again at half of what is left, and drops the mapping
//     only when the lease ends; the mapper recreates it after the gateway
//     changes. A mapping whose external address is not public, as behind a
//     second NAT, is ignored.
//   - stun: the address reflected by STUN servers, asked through the shared
//     socket so the reflected port is the QUIC port.
//
// Every candidate must pass pairing.ValidCandidate, the rule of the QR. Public
// IPv4 addresses found on an interface are not listed as lan; STUN reflects
// them. Snapshot.ForQR picks at most pairing.MaxCandidates alternating the
// types, and the reach card carries up to MaxCardCandidates.
//
// # STUN is optional
//
// STUN is the only source that talks to a server outside the local network,
// so it is off unless Config.STUNServers lists at least one "host:port". The
// list is configurable and has no built-in default. When it is empty the
// collector never sends a STUN request and the snapshot has no stun
// candidates; LAN, IPv6 and the mapped port still work, and a desktop behind
// a NAT without port mapping stays reachable through the Tor fallback.
//
// When enabled, the servers are asked in parallel only while there is no
// usable mapping: when the collector starts, on every Collect, after a network
// change and when a mapping expires. Each round has a total deadline of Config.STUNTimeout,
// DefaultSTUNTimeout (2 s) by default, and retransmits the request after 500
// ms and 1.5 s. A server that does not answer in time is only logged. Replies
// are accepted only from the queried address with the matching transaction id.
//
// # Changes
//
// Collect gathers fresh candidates on demand and Snapshot returns the last
// ones without touching the network. Config.OnChange runs, in order and never
// concurrently, whenever the candidate list changes: a mapping obtained,
// renewed to another address or expired, a STUN answer, or a network change
// reported by the port mapper monitor or by NetworkChanged, which the mobile
// layer calls because it has no network monitor.
package candidates
