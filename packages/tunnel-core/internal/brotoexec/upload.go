package brotoexec

import (
	"errors"
	"os"
	"time"
)

// A stable lock inode is retained after completion. Removing it would allow a
// waiting process and a new process to hold locks on different inodes for the
// same destination. Locks are released by the OS when the owner crashes.
func acquireTransferLock(root *os.Root, name string) (func(), error) {
	name += ".cialai-part.lock"
	if info, err := root.Lstat(name); err == nil && !info.Mode().IsRegular() {
		return nil, failure("file_transfer_busy", "O bloqueio da transferência não é um arquivo comum.")
	}
	f, err := root.OpenFile(name, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	unlock, err := lockTransfer(f)
	if err != nil {
		f.Close()
		return nil, failure("file_transfer_busy", "Outra transferência está usando este destino.")
	}
	info, err := root.Lstat(name)
	opened, statErr := f.Stat()
	if err != nil || statErr != nil || !info.Mode().IsRegular() || !os.SameFile(info, opened) {
		unlock()
		f.Close()
		return nil, failure("file_transfer_busy", "O bloqueio da transferência mudou.")
	}
	return func() { unlock(); f.Close() }, nil
}
func openUploadPart(root *os.Root, name string) (*os.File, error) {
	name += ".cialai-part"
	if info, err := root.Lstat(name); err == nil && !info.Mode().IsRegular() {
		return nil, failure("file_transfer_busy", "O arquivo temporário não é um arquivo comum.")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	f, err := root.OpenFile(name, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	opened, err := f.Stat()
	info, statErr := root.Lstat(name)
	if err != nil || statErr != nil || !info.Mode().IsRegular() || !os.SameFile(opened, info) {
		f.Close()
		return nil, failure("file_transfer_busy", "O arquivo temporário mudou.")
	}
	if err = f.Truncate(0); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func (e *Executor) releaseUpload(key string, u *upload, remove bool) {
	if u.expiry != nil {
		u.expiry.Stop()
	}
	info, _ := u.file.Stat()
	if info == nil {
		info = u.info
	}
	u.file.Close()
	if remove {
		if current, err := u.root.Lstat(u.name + ".cialai-part"); err == nil && info != nil && os.SameFile(info, current) {
			_ = u.root.Remove(u.name + ".cialai-part")
		}
	}
	u.unlock()
	u.root.Close()
	delete(e.uploads, key)
}
func (e *Executor) expireUpload(key string, u *upload) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.uploads[key] != u {
		return
	}
	remaining := e.config.transferIdleTimeout - time.Since(u.updated)
	if remaining > 0 {
		u.expiry.Reset(remaining)
		return
	}
	e.releaseUpload(key, u, true)
}
