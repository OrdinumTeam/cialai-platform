// SPDX-License-Identifier: Apache-2.0
package statedir

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLegacyIdentityDistinguishesRebootReuseAndPermissionDenial(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pid")
	if err := os.WriteFile(path, []byte(`{"pid":42,"nonce":"old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), "cialai-tunnel")
	for _, test := range []struct {
		name     string
		identity processIdentity
		err      error
		blocked  bool
	}{
		{"live original tunnel", processIdentity{exe, stamp.Add(-time.Minute)}, nil, true},
		{"same exe after simulated reboot", processIdentity{exe, stamp.Add(time.Minute)}, nil, false},
		{"recycled unrelated pid", processIdentity{filepath.Join(t.TempDir(), "gmain"), stamp.Add(-time.Minute)}, nil, false},
		{"exited or zombie", processIdentity{}, os.ErrNotExist, false},
		{"cannot prove ownership with denied access", processIdentity{}, os.ErrPermission, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := checkLegacyOwner(path, exe, func(int) bool { return true }, func(int) (processIdentity, error) { return test.identity, test.err })
			if (err != nil) != test.blocked {
				t.Fatalf("blocked=%v, error=%v", test.blocked, err)
			}
			if test.name == "live original tunnel" && !errors.Is(err, ErrLocked) {
				t.Fatalf("expected live lock: %v", err)
			}
		})
	}
}
