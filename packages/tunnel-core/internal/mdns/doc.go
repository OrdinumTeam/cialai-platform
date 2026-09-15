// SPDX-License-Identifier: Apache-2.0
// Package mdns announces the desktop on the local network with DNS-SD over
// multicast DNS and validates what a phone discovers, so a phone on the same
// network reaches the direct QUIC listener without waiting for Tor and without
// a remembered address.
//
// # Service
//
// The desktop registers one instance of ServiceType, "_cialai._udp", in the
// "local" domain:
//
//   - Instance "cialai-<fingerprint>" on host "cialai-<fingerprint>.local",
//     both derived from the key, so neither the computer name nor the name of
//     the person goes on the network.
//   - SRV: the UDP port of the direct QUIC listener.
//   - TXT: "v=1", "id=<desktop id d_...>" and "fp=<fingerprint>", the short
//     hexadecimal form of identity.Fingerprint.
//   - A and AAAA: the announcements carry the LAN addresses of each interface,
//     as the candidates package lists them: private IPv4, the shared address
//     space 100.64.0.0/10 and IPv6 unique local addresses. Answers to queries
//     come from pion and carry one address of the interface the query
//     arrived on, IPv4 first, which may be an IPv6 link-local address on an
//     interface without IPv4.
//
// The id encodes the first 16 bytes of SHA-256 over the public key and the
// fingerprint is the hexadecimal of the first 8, so the id alone determines
// the fingerprint and a TXT whose fp does not match its id is rejected. None
// of this authenticates the desktop: discovery only yields addresses to try,
// and the mutual TLS of the direct transport pins the key.
//
// # Announcer
//
// Start answers queries with github.com/pion/mdns/v2 on every interface that
// is up, supports multicast, is not a point-to-point tunnel and has a LAN
// address. It also sends the unsolicited announcement of RFC 6762 section 8.3
// twice, one second apart, with the cache-flush bit on the SRV, TXT and
// address records, because pion answers queries but does not announce.
// Refresh reads the interfaces again and, when an interface or an address
// changed, reopens the sockets and announces again; SetPort does the same for
// a new listener port. The owner calls Refresh whenever the candidates or the
// network change. Close sends a goodbye with TTL zero so browsers drop the
// instance at once. Without a usable interface the announcer stays idle until
// a Refresh finds one.
//
// The instance name is not probed for conflicts: it derives from the key, so
// a conflict means the same identity runs twice on one network.
//
// The responder shares UDP port 5353 with the system responder (mDNSResponder,
// Avahi or the Windows DNS client) through the address reuse options that Go
// sets on multicast sockets. Multicast packets reach every socket, but the
// kernel delivers a unicast packet addressed to port 5353 to only one of them,
// so a unicast reply meant for the system responder may be taken by this one;
// the system then asks again by multicast. On macOS 15 and later the local
// network permission of the app responsible for the process covers the
// sidecar; without it every multicast send fails with EHOSTUNREACH, the
// announcement never leaves the computer and only loopback keeps working.
//
// # Browsing
//
// Browse is the pure Go client: it asks for ServiceType during the given time
// and returns every desktop whose TXT is valid, with the LAN addresses and the
// SRV port. It serves the tests, the local network lab and desktop or Android
// builds without a native discovery API.
//
// # Phones
//
// On iOS the Go core never opens a multicast socket on its own: opening one
// directly requires the com.apple.developer.networking.multicast entitlement,
// so iOS discovers the desktop with NWBrowser, with ServiceType declared in
// NSBonjourServices, and Start and Browse return ErrUnsupported there. Android
// discovers it with NsdManager; Browse stays a fallback there only while the
// native layer holds a WifiManager.MulticastLock. The native layer resolves
// each instance, keeps those whose TXT id is the expected desktop and hands at
// most MaxReported entries, one per resolved address, as JSON to
// ParseReported, which validates them again, drops the addresses outside the
// LAN and returns the ones to dial.
package mdns
