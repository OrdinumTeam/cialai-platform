// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"strings"

	pion "github.com/pion/mdns/v2"
)

const (
	// ServiceType is the DNS-SD service announced by the desktop.
	ServiceType = "_cialai._udp"
	// TXTVersion is the value of the "v" key this package announces and
	// accepts.
	TXTVersion = "1"

	domain         = "local"
	instancePrefix = "cialai-"
	desktopPrefix  = "d_"
	idBytes        = 16
	// fingerprintBytes matches identity.Fingerprint.
	fingerprintBytes = 8
)

var (
	// sharedAddressSpace is RFC 6598, accepted as lan by the pairing rules.
	sharedAddressSpace = netip.MustParsePrefix("100.64.0.0/10")

	errInvalidTXT = errors.New("mdns: TXT record is invalid")
)

// fingerprintOf returns the fingerprint of the key behind a desktop id. The
// id encodes the first 16 bytes of SHA-256 over the public key and
// identity.Fingerprint is the hexadecimal of the first 8, so the id pins it.
func fingerprintOf(id string) (string, bool) {
	encoded, found := strings.CutPrefix(id, desktopPrefix)
	if !found || encoded == "" {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != idBytes || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return "", false
	}
	return hex.EncodeToString(raw[:fingerprintBytes]), true
}

// instanceName is the DNS-SD instance of the desktop with this fingerprint.
func instanceName(fingerprint string) string { return instancePrefix + fingerprint }

// hostName is the host of the SRV record, without the trailing dot.
func hostName(fingerprint string) string { return instancePrefix + fingerprint + "." + domain }

func txtEntries(id, fingerprint string) []pion.TXTEntry {
	return []pion.TXTEntry{
		pion.NewTXTString("v", TXTVersion),
		pion.NewTXTString("id", id),
		pion.NewTXTString("fp", fingerprint),
	}
}

func txtStrings(id, fingerprint string) []string {
	return []string{"v=" + TXTVersion, "id=" + id, "fp=" + fingerprint}
}

// parseTXT validates a decoded TXT record and returns the desktop id and its
// fingerprint. Keys are case-insensitive and the first occurrence wins, as in
// RFC 6763 section 6.4; unknown keys are ignored.
func parseTXT(entries []pion.TXTEntry) (string, string, error) {
	lookup := func(key string) (string, bool) {
		for _, entry := range entries {
			if strings.EqualFold(entry.Key, key) {
				return string(entry.Value), entry.Value != nil
			}
		}
		return "", false
	}
	if version, ok := lookup("v"); !ok || version != TXTVersion {
		return "", "", fmt.Errorf("%w: version", errInvalidTXT)
	}
	id, _ := lookup("id")
	expected, ok := fingerprintOf(id)
	if !ok {
		return "", "", fmt.Errorf("%w: desktop id", errInvalidTXT)
	}
	if fingerprint, _ := lookup("fp"); fingerprint != expected {
		return "", "", fmt.Errorf("%w: fingerprint does not match the id", errInvalidTXT)
	}
	return id, expected, nil
}

// lanAddress reports whether address, unmapped and without a zone, can be
// dialed on the local network: private IPv4, the shared address space or an
// IPv6 unique local address. IPv4 loopback passes only when loopback is true,
// for an announcer or a browser bound to a loopback interface in tests; IPv6
// loopback never does, because macOS has no multicast route for it.
func lanAddress(address netip.Addr, loopback bool) bool {
	switch {
	case !address.IsValid() || address.Zone() != "" || address.Is4In6():
		return false
	case address.IsLoopback():
		return loopback && address.Is4()
	default:
		return address.IsPrivate() || sharedAddressSpace.Contains(address)
	}
}
