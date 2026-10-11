// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package identity

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// fakeFileInfo stands for a key file owned by an arbitrary uid, which a test
// cannot create on disk without privileges.
type fakeFileInfo struct {
	mode os.FileMode
	sys  any
}

func (info fakeFileInfo) Name() string       { return KeyFileName }
func (info fakeFileInfo) Size() int64        { return 44 }
func (info fakeFileInfo) Mode() os.FileMode  { return info.mode }
func (info fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (info fakeFileInfo) IsDir() bool        { return false }
func (info fakeFileInfo) Sys() any           { return info.sys }

func TestOwnedByCallerRequiresTheEffectiveUser(t *testing.T) {
	uid := uint32(os.Geteuid())
	cases := map[string]struct {
		sys  any
		want bool
	}{
		"own file":          {sys: &syscall.Stat_t{Uid: uid}, want: true},
		"another user":      {sys: &syscall.Stat_t{Uid: uid + 1}, want: false},
		"unknown stat type": {sys: nil, want: false},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			if got := ownedByCaller(fakeFileInfo{mode: 0o644, sys: test.sys}); got != test.want {
				t.Fatalf("ownedByCaller = %v, want %v", got, test.want)
			}
		})
	}
	// The real key written by this process is owned by it.
	dir := t.TempDir()
	if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: dir}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, KeyFileName))
	if err != nil || !ownedByCaller(info) {
		t.Fatalf("own key not recognised (err %v)", err)
	}
}

// A private key never gets its mode touched.
func TestEnsurePrivateLeavesPrivateKeysAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, KeyFileName)
	if err := os.WriteFile(path, []byte("seed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := ensurePrivate(file); err != nil {
		t.Fatalf("private key rejected: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode = %04o (err %v), want 0600 untouched", info.Mode().Perm(), err)
	}
}
