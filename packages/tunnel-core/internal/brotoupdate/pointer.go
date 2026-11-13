// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"errors"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"os"
	"path/filepath"
	"strings"
)

func validatePointer(result Result) error {
	if result.CurrentPointer == "" {
		return nil
	}
	if e := privateDirectory(filepath.Dir(result.CurrentPointer)); e != nil {
		return e
	}
	st, e := os.Lstat(result.CurrentPointer)
	if e != nil || !st.Mode().IsRegular() {
		return errors.New("unsafe current release pointer")
	}
	raw, e := statedir.ReadFile(result.CurrentPointer)
	if e != nil {
		return e
	}
	if strings.TrimSpace(string(raw)) != result.PreviousBinary {
		return errors.New("current release pointer does not match active binary")
	}
	return nil
}
func commitPointer(result Result) error {
	if result.CurrentPointer == "" {
		return nil
	}
	return atomicPointerWrite(result.CurrentPointer, []byte(result.NextBinary+"\n"))
}
func atomicPointerWrite(path string, data []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".current-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return statedir.Rename(f.Name(), path)
}
