// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"testing"
)

func reportJSON(t *testing.T, entries ...reportedEntry) []byte {
	t.Helper()
	if entries == nil {
		entries = []reportedEntry{}
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseReportedAcceptsLANAddresses(t *testing.T) {
	_, id, fingerprint := testDesktop(t)
	entry := func(host string, port int) reportedEntry {
		return reportedEntry{Host: host, Port: port, ID: id, FP: fingerprint}
	}
	raw := reportJSON(t,
		entry("192.168.1.20", 4740),
		entry("fd12:3456::20", 4740),
		entry("100.64.1.2", 4740),
		entry("192.168.1.20", 4740),
		entry("10.0.0.5%en0", 4741),
		entry("::ffff:172.16.0.9", 65535),
	)
	addresses, err := ParseReported(id, raw)
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.AddrPort{
		netip.MustParseAddrPort("192.168.1.20:4740"),
		netip.MustParseAddrPort("[fd12:3456::20]:4740"),
		netip.MustParseAddrPort("100.64.1.2:4740"),
		netip.MustParseAddrPort("10.0.0.5:4741"),
		netip.MustParseAddrPort("172.16.0.9:65535"),
	}
	if !slices.Equal(addresses, want) {
		t.Fatalf("addresses = %v, want %v", addresses, want)
	}

	documented := fmt.Sprintf(`[{"host":"192.168.1.20","port":4740,"id":%q,"fp":%q}]`, id, fingerprint)
	if addresses, err := ParseReported(id, []byte(documented)); err != nil || len(addresses) != 1 {
		t.Fatalf("documented example: %v, %v", addresses, err)
	}
	if addresses, err := ParseReported(id, []byte(" [ ] \n")); err != nil || addresses == nil || len(addresses) != 0 {
		t.Fatalf("empty report: %v, %v", addresses, err)
	}
}

func TestParseReportedDropsAddressesOutsideTheLAN(t *testing.T) {
	_, id, fingerprint := testDesktop(t)
	entry := func(host string) reportedEntry {
		return reportedEntry{Host: host, Port: 4740, ID: id, FP: fingerprint}
	}
	raw := reportJSON(t,
		entry("fe80::1c2a:3bff:fe4d:5e6f%en0"),
		entry("192.168.1.20"),
		entry("2001:db8::20"),
		entry("8.8.8.8"),
		entry("169.254.10.20"),
		entry("127.0.0.1"),
		entry("224.0.0.251"),
		entry("0.0.0.0"),
	)
	addresses, err := ParseReported(id, raw)
	if err != nil || !slices.Equal(addresses, []netip.AddrPort{netip.MustParseAddrPort("192.168.1.20:4740")}) {
		t.Fatalf("ParseReported = %v, %v", addresses, err)
	}
	addresses, err = ParseReported(id, reportJSON(t, entry("fe80::1%en0"), entry("::1")))
	if err != nil || addresses == nil || len(addresses) != 0 {
		t.Fatalf("report without LAN addresses: %v, %v", addresses, err)
	}
}

func TestParseReportedRefusesInvalidEntries(t *testing.T) {
	_, id, fingerprint := testDesktop(t)
	_, otherID, otherFingerprint := testDesktop(t)
	good := reportedEntry{Host: "192.168.1.20", Port: 4740, ID: id, FP: fingerprint}
	cases := map[string]reportedEntry{
		"other id":              {Host: "192.168.1.21", Port: 4740, ID: otherID, FP: otherFingerprint},
		"other id same print":   {Host: "192.168.1.21", Port: 4740, ID: otherID, FP: fingerprint},
		"other fingerprint":     {Host: "192.168.1.21", Port: 4740, ID: id, FP: otherFingerprint},
		"uppercase fingerprint": {Host: "192.168.1.21", Port: 4740, ID: id, FP: strings.ToUpper(fingerprint)},
		"missing fingerprint":   {Host: "192.168.1.21", Port: 4740, ID: id},
		"missing id":            {Host: "192.168.1.21", Port: 4740, FP: fingerprint},
		"host name":             {Host: "cialai-" + fingerprint + ".local.", Port: 4740, ID: id, FP: fingerprint},
		"address with port":     {Host: "192.168.1.21:4740", Port: 4740, ID: id, FP: fingerprint},
		"empty host":            {Port: 4740, ID: id, FP: fingerprint},
		"port zero":             {Host: "192.168.1.21", ID: id, FP: fingerprint},
		"port too large":        {Host: "192.168.1.21", Port: 65536, ID: id, FP: fingerprint},
		"negative port":         {Host: "192.168.1.21", Port: -1, ID: id, FP: fingerprint},
	}
	for name, bad := range cases {
		addresses, err := ParseReported(id, reportJSON(t, good, bad))
		if !errors.Is(err, ErrReportInvalid) || addresses != nil {
			t.Errorf("%s: ParseReported = %v, %v", name, addresses, err)
		}
	}
}

func TestParseReportedRefusesMalformedReports(t *testing.T) {
	_, id, fingerprint := testDesktop(t)
	entry := reportedEntry{Host: "192.168.1.20", Port: 4740, ID: id, FP: fingerprint}
	single := string(reportJSON(t, entry))

	many := make([]reportedEntry, MaxReported+1)
	for index := range many {
		many[index] = reportedEntry{Host: fmt.Sprintf("192.168.1.%d", index+1), Port: 4740, ID: id, FP: fingerprint}
	}
	if addresses, err := ParseReported(id, reportJSON(t, many[:MaxReported]...)); err != nil || len(addresses) != MaxReported {
		t.Fatalf("report at the limit: %d addresses, %v", len(addresses), err)
	}

	cases := map[string][]byte{
		"over the entry limit": reportJSON(t, many...),
		"over the byte limit":  []byte("[" + strings.Repeat(" ", MaxReportBytes) + "]"),
		"null":                 []byte("null"),
		"object":               []byte(strings.Trim(single, "[]")),
		"empty input":          nil,
		"trailing data":        []byte(single + "[]"),
		"unknown field":        []byte(strings.Replace(single, `"host"`, `"name":"Mac","host"`, 1)),
		"port as text":         []byte(strings.Replace(single, `"port":4740`, `"port":"4740"`, 1)),
		"fractional port":      []byte(strings.Replace(single, `"port":4740`, `"port":4740.5`, 1)),
		"truncated":            []byte(single[:len(single)-2]),
	}
	for name, raw := range cases {
		addresses, err := ParseReported(id, raw)
		if !errors.Is(err, ErrReportInvalid) || addresses != nil {
			t.Errorf("%s: ParseReported = %v, %v", name, addresses, err)
		}
	}

	for _, expected := range []string{"", "dev_" + strings.TrimPrefix(id, "d_"), id + "x"} {
		if _, err := ParseReported(expected, []byte(single)); !errors.Is(err, ErrReportInvalid) {
			t.Errorf("expected id %q: %v", expected, err)
		}
	}
}
