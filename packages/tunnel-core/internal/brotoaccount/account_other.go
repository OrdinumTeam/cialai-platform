//go:build !windows

// SPDX-License-Identifier: Apache-2.0

package brotoaccount

// PasswordService is a Windows matter; services elsewhere never take a password.
func PasswordService() bool { return false }
