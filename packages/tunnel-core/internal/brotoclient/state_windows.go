//go:build windows

package brotoclient

import (
	"errors"
	"io/fs"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// Chmod cannot express Windows privacy. Protect the state before opening an
// identity or token, including pre-existing files with explicit broad ACLs.
func protectState(root string) error {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	sid := user.User.Sid
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + sid.String() + ")")
	if err != nil {
		return err
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(name)
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("state cannot contain reparse points")
		}
		previous, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		owner, _, err := previous.Owner()
		if err != nil {
			return err
		}
		if owner == nil || (!owner.Equals(sid) && !(token.IsElevated() && owner.IsWellKnown(windows.WinBuiltinAdministratorsSid))) {
			return errors.New("state belongs to another Windows account")
		}
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	})
}
