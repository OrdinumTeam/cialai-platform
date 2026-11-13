//go:build windows

// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"errors"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoaccount"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

// The installer creates the releases as the owner and the updater, run as
// LocalSystem, adds new ones. Both accounts, and Administrators, stay trusted.
func privateDirectory(path string) error {
	_, e := os.Lstat(path)
	created := os.IsNotExist(e)
	if e != nil && !created {
		return e
	}
	if e = os.MkdirAll(path, 0700); e != nil {
		return e
	}
	st, e := os.Lstat(path)
	if e != nil || !st.IsDir() {
		return errors.New("unsafe releases directory")
	}
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return e
	}
	account, e := brotoaccount.Owner()
	if e != nil {
		return e
	}
	if created {
		sd, e := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + account.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
		if e != nil {
			return e
		}
		acl, _, e := sd.DACL()
		if e != nil {
			return e
		}
		if e = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION, user.User.Sid, nil, acl, nil); e != nil {
			return e
		}
	}
	sd, e := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return e
	}
	owner, _, e := sd.Owner()
	if e != nil || owner == nil || !brotoaccount.Trusted(owner, account) {
		return errors.New("releases directory owner mismatch")
	}
	acl, _, e := sd.DACL()
	if e != nil || acl == nil {
		return errors.New("unprotected releases directory")
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if e = windows.GetAce(acl, i, &ace); e != nil {
			return e
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("unsupported releases directory ACL")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !brotoaccount.Trusted(sid, account) {
			return errors.New("releases directory allows another account")
		}
	}
	return nil
}
