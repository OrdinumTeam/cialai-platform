// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"slices"
	"strings"
)

const (
	// MaxReported caps the entries of one report and the addresses Browse
	// keeps for one desktop.
	MaxReported = 8
	// MaxReportBytes caps the JSON of one report.
	MaxReportBytes = 4096
)

// ErrReportInvalid is returned by ParseReported for any report it refuses.
var ErrReportInvalid = errors.New("local network discovery report is invalid")

// reportedEntry is one resolved instance as the native browser reports it.
type reportedEntry struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	ID   string `json:"id"`
	FP   string `json:"fp"`
}

// ParseReported validates the instances resolved by the native DNS-SD browser
// of the phone and returns the addresses to dial, in the reported order and
// without repeats. The report is a JSON array such as
//
//	[{"host":"192.168.1.20","port":4740,"id":"d_...","fp":"..."}]
//
// with at most MaxReported entries, one per resolved address, taken from the
// address records, the SRV port and the TXT record. The native layer reports
// only the instances whose TXT id is desktopID, so the whole report is refused
// when an entry carries another id or a fingerprint that does not match it,
// when a host is not an IP address literal, when a port is out of range, when
// a field is unknown or when the JSON is malformed or too large.
//
// Addresses outside the LAN ranges (private IPv4, 100.64.0.0/10 and IPv6
// unique local) are dropped without refusing the report, because resolving a
// host on the local network commonly also yields its link-local or global IPv6
// address; loopback, link-local, multicast and public addresses are never
// returned. A "%interface" suffix is ignored. An empty array, or one whose
// addresses were all dropped, yields no addresses.
func ParseReported(desktopID string, raw []byte) ([]netip.AddrPort, error) {
	expected, ok := fingerprintOf(desktopID)
	if !ok {
		return nil, fmt.Errorf("%w: expected desktop id", ErrReportInvalid)
	}
	if len(raw) > MaxReportBytes {
		return nil, fmt.Errorf("%w: exceeds %d bytes", ErrReportInvalid, MaxReportBytes)
	}
	var entries []reportedEntry
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrReportInvalid, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing data", ErrReportInvalid)
	}
	switch {
	case entries == nil:
		return nil, fmt.Errorf("%w: not a list", ErrReportInvalid)
	case len(entries) > MaxReported:
		return nil, fmt.Errorf("%w: more than %d entries", ErrReportInvalid, MaxReported)
	}
	addresses := make([]netip.AddrPort, 0, len(entries))
	for index, entry := range entries {
		if entry.ID != desktopID {
			return nil, fmt.Errorf("%w: entry %d is another desktop", ErrReportInvalid, index)
		}
		if entry.FP != expected {
			return nil, fmt.Errorf("%w: entry %d fingerprint does not match the desktop", ErrReportInvalid, index)
		}
		address, err := reportedAddress(entry.Host, entry.Port)
		if err != nil {
			return nil, fmt.Errorf("%w: entry %d %w", ErrReportInvalid, index, err)
		}
		if lanAddress(address.Addr(), false) && !slices.Contains(addresses, address) {
			addresses = append(addresses, address)
		}
	}
	return addresses, nil
}

// reportedAddress parses an entry address, dropping a zone and unmapping an
// IPv4-mapped IPv6 address; the caller decides whether it is dialable.
func reportedAddress(host string, port int) (netip.AddrPort, error) {
	if port < 1 || port > 65535 {
		return netip.AddrPort{}, fmt.Errorf("port %d is out of range", port)
	}
	literal, _, _ := strings.Cut(host, "%")
	address, err := netip.ParseAddr(literal)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("host %q is not an IP address", host)
	}
	return netip.AddrPortFrom(address.Unmap(), uint16(port)), nil
}
