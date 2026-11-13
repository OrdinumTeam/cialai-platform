//go:build windows

package brotoclient

import "github.com/Cialai/cialai/packages/tunnel-core/internal/brotoaccount"

// The service runs as LocalSystem, so the state is shared by the owner and
// LocalSystem and by no one else.
func protectState(root string) error { return brotoaccount.ProtectState(root) }
