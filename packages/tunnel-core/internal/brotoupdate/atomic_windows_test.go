//go:build windows

package brotoupdate

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAtomicPointersWaitForWindowsReaders(t *testing.T) {
	for _, name := range []string{"current-path", "active-path"} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "private")
			if e := ProtectDirectory(root); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(root, name)
			if e := atomicPointerWrite(path, []byte("old\n")); e != nil {
				t.Fatal(e)
			}
			wide, e := windows.UTF16PtrFromString(path)
			if e != nil {
				t.Fatal(e)
			}
			handle, e := windows.CreateFile(wide, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
			if e != nil {
				t.Fatal(e)
			}
			released := make(chan struct{})
			go func() { time.Sleep(100 * time.Millisecond); _ = windows.CloseHandle(handle); close(released) }()
			started := time.Now()
			e = atomicPointerWrite(path, []byte("new\n"))
			<-released
			if e != nil {
				t.Fatal("transient reader prevented pointer replacement", e)
			}
			if time.Since(started) < 50*time.Millisecond {
				t.Fatal("fixture did not exercise a sharing violation")
			}
			raw, e := os.ReadFile(path)
			if e != nil || string(raw) != "new\n" {
				t.Fatal("pointer content incorrect", e)
			}
		})
	}
}
