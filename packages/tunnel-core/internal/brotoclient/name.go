// SPDX-License-Identifier: Apache-2.0
package brotoclient

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// The pairing registry accepts up to 48 Unicode characters. A DNS hostname
// can be longer; only that automatic default is shortened, never an explicit
// user choice. Both the identity record and pairing request use this name.
func brotoName(configured, hostname string) (string, error) {
	if configured != "" {
		if !utf8.ValidString(configured) || utf8.RuneCountInString(configured) > 48 || strings.IndexFunc(configured, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return "", errors.New("Broto name must contain at most 48 characters and no control characters")
		}
		return configured, nil
	}
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.ToValidUTF8(hostname, "")))
	runes := []rune(name)
	if len(runes) > 48 {
		name = string(runes[:48])
	}
	if name == "" {
		name = "Cialai Broto"
	}
	return name, nil
}
