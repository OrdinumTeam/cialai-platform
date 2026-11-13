//go:build windows

package brotoclient

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsStateTightensACLBeforePrivateWrites(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old-private-data")
	if err := os.WriteFile(old, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	broad, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{dir, old} {
		if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatal(err)
		}
	}
	client, err := New(context.Background(), Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{dir, old, filepath.Join(dir, "identity.key"), filepath.Join(dir, "identity.json")} {
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		acl, _, err := descriptor.DACL()
		if err != nil || acl == nil || acl.AceCount != 2 {
			t.Fatal("state ACL is not restricted to the owner and LocalSystem", path, err)
		}
		for index := uint32(0); index < 2; index++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err = windows.GetAce(acl, index, &ace); err != nil {
				t.Fatal(err)
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || !(sid.Equals(user.User.Sid) || sid.IsWellKnown(windows.WinLocalSystemSid)) {
				t.Fatal("state ACL grants access outside the owner and LocalSystem", path)
			}
		}
		if path == dir {
			control, _, err := descriptor.Control()
			if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
				t.Fatal("state root inherits a broad DACL")
			}
		}
	}
}
