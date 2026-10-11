// SPDX-License-Identifier: Apache-2.0
//go:build !windows

package tor

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

func (info fakeFileInfo) Name() string       { return "onion.key" }
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
	path := filepath.Join(t.TempDir(), "tor", "onion.key")
	if _, _, err := LoadOrCreateOnionKey(path, nil); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || !ownedByCaller(info) {
		t.Fatalf("own key not recognised (err %v)", err)
	}
}
