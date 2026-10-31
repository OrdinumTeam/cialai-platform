// SPDX-License-Identifier: Apache-2.0

// Package brotoaccount names the Windows account the Broto works for. The
// service runs as LocalSystem, so no password is ever asked, and learns the
// owner from the installer. Every other process, as the window or the
// installer, works for its own account.
package brotoaccount
