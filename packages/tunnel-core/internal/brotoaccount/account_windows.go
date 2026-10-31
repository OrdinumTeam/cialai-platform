//go:build windows

// SPDX-License-Identifier: Apache-2.0

package brotoaccount

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// OwnerEnv carries the owner SID in the service environment. Only an
// administrator can write it, in the service key of the registry.
const OwnerEnv = "CIALAI_BROTO_OWNER_SID"

// Owner is the account whose pipes, state and releases the Broto keeps.
func Owner() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	if !user.User.Sid.IsWellKnown(windows.WinLocalSystemSid) {
		return user.User.Sid, nil
	}
	value := os.Getenv(OwnerEnv)
	if value == "" {
		return user.User.Sid, nil
	}
	if !strings.HasPrefix(value, "S-1-5-21-") {
		return nil, errors.New("invalid Broto owner account")
	}
	return windows.StringToSid(value)
}

// Trusted reports whether a SID may own or reach Broto files: the owner,
// LocalSystem, which runs the service, or the Administrators group, which
// owns what an elevated installer or LocalSystem creates.
func Trusted(sid, owner *windows.SID) bool {
	return sid.Equals(owner) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid)
}

// ProtectState limits the state to the owner and LocalSystem before any
// identity or token is opened, including pre-existing files with explicit
// broad ACLs. Chmod cannot express Windows privacy.
func ProtectState(root string) error {
	owner, err := Owner()
	if err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + owner.String() + ")(A;OICI;FA;;;SY)")
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
		fileOwner, _, err := previous.Owner()
		if err != nil {
			return err
		}
		if fileOwner == nil || !Trusted(fileOwner, owner) {
			return errors.New("state belongs to another Windows account")
		}
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	})
}
