// SPDX-License-Identifier: Apache-2.0
package control

import "testing"

func TestAPIKeyPrefixKeepsDashesInsideTheFixedLengthPrefix(t *testing.T) {
	const secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123"
	for _, tc := range []struct {
		key  string
		want string
	}{
		{"hskey-api-FYQT-7gktHAV-" + secret, "hskey-api-FYQT-7gktHAV"},
		{"hskey-api-7Y-BtzrE7y8c-" + secret, "hskey-api-7Y-BtzrE7y8c"},
		{"hskey-api-_KcCpQuLBJCa-" + secret, "hskey-api-_KcCpQuLBJCa"},
		{"hskey-api-test-secret", "hskey-api-test"},
		{"hskey-api-visible-secret-material", "hskey-api-visible"},
		{"hskey-api-nodashatallhere", "hskey-api-nodashatallh"},
	} {
		if got := APIKeyPrefix(tc.key); got != tc.want {
			t.Errorf("APIKeyPrefix for %s: got %s, want %s", tc.want, got, tc.want)
		}
	}
}

func TestSameAPIKeyPrefixMatchesTheListedSpelling(t *testing.T) {
	if !SameAPIKeyPrefix("hskey-api-FYQT-7gktHAV-***", "hskey-api-FYQT-7gktHAV") {
		t.Fatal("listed prefix with dash did not match")
	}
	if SameAPIKeyPrefix("hskey-api-FYQT-7gktHAX-***", "hskey-api-FYQT-7gktHAV") {
		t.Fatal("different prefixes matched")
	}
	if SameAPIKeyPrefix("-***", "hskey-api-") {
		t.Fatal("empty prefixes matched")
	}
}
