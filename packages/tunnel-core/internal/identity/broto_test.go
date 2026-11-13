// SPDX-License-Identifier: Apache-2.0
package identity

import (
	"bytes"
	"strings"
	"testing"
)

func TestBrotoIdentitySeparatesRoleAndPreservesKey(t *testing.T) {
	seed := bytes.Repeat([]byte{42}, 32)
	broto, err := FromSeed(RoleBroto, seed)
	if err != nil {
		t.Fatal(err)
	}
	phone, err := FromSeed(RolePhone, seed)
	if err != nil {
		t.Fatal(err)
	}
	if broto.Role() != RoleBroto || !strings.HasPrefix(broto.ID(), "bro_") || broto.ID() == phone.ID() {
		t.Fatal("role not reflected in identity")
	}
	if !bytes.Equal(broto.PublicKey(), phone.PublicKey()) {
		t.Fatal("role unexpectedly changes key")
	}
	if _, err := DeriveID(RoleBroto, nil); err == nil {
		t.Fatal("invalid key accepted")
	}
}
