// SPDX-License-Identifier: Apache-2.0
package brotoclient

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBrotoNamePreservesConfiguredLabelAndBoundsHostnameDefault(t *testing.T) {
	for _, tc := range []struct{ name, configured, hostname, want string }{
		{"configured", "Máquina escolhida", "other-host", "Máquina escolhida"},
		{"hostname", "", "workstation", "workstation"},
		{"long DNS hostname", "", strings.Repeat("a", 63) + ".example.test", strings.Repeat("a", 48)},
		{"Unicode boundary", "", strings.Repeat("🌱", 60), strings.Repeat("🌱", 48)},
		{"empty hostname", "", "", "Cialai Broto"},
		{"invalid hostname bytes", "", "bad\xffhost\n", "badhost"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := brotoName(tc.configured, tc.hostname)
			if err != nil || got != tc.want || !utf8.ValidString(got) {
				t.Fatalf("name %q, error %v", got, err)
			}
		})
	}
	for _, invalid := range []string{strings.Repeat("a", 49), "line\nbreak", "bad\x7f", "bad\xff"} {
		if _, err := brotoName(invalid, "fallback"); err == nil {
			t.Fatal("invalid explicit name silently accepted")
		}
	}
}
