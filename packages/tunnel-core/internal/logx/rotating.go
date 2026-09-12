// SPDX-License-Identifier: Apache-2.0
package logx

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
)

type RotatingFile struct {
	mu      sync.Mutex
	path    string
	maximum int64
	backups int
	file    *os.File
	size    int64
}

func NewRotatingFile(path string, maximum int64, backups int) (*RotatingFile, error) {
	if path == "" || maximum <= 0 || backups < 1 {
		return nil, errors.New("log path, maximum size and backups are required")
	}
	writer := &RotatingFile{path: path, maximum: maximum, backups: backups}
	if err := writer.open(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (writer *RotatingFile) open() error {
	if info, err := os.Lstat(writer.path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("tunnel log must be a regular file, not a symbolic link")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect tunnel log: %w", err)
	}
	file, err := os.OpenFile(writer.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open tunnel log: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	pathInfo, err := os.Lstat(writer.path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() || !os.SameFile(info, pathInfo) {
		_ = file.Close()
		return errors.New("tunnel log path changed while it was opened")
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("protect tunnel log: %w", err)
	}
	writer.file = file
	writer.size = info.Size()
	return nil
}

func (writer *RotatingFile) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.file == nil {
		return 0, errors.New("tunnel log is closed")
	}
	if writer.size > 0 && writer.size+int64(len(data)) > writer.maximum {
		if err := writer.rotate(); err != nil {
			return 0, err
		}
	}
	written, err := writer.file.Write(data)
	writer.size += int64(written)
	return written, err
}

func (writer *RotatingFile) rotate() error {
	if err := writer.file.Close(); err != nil {
		return err
	}
	writer.file = nil
	for index := writer.backups; index >= 1; index-- {
		target := writer.path + "." + strconv.Itoa(index)
		source := writer.path
		if index > 1 {
			source = writer.path + "." + strconv.Itoa(index-1)
		}
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("replace rotated tunnel log: %w", err)
		}
		if err := os.Rename(source, target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rotate tunnel log: %w", err)
		}
	}
	return writer.open()
}

func (writer *RotatingFile) Close() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.file == nil {
		return nil
	}
	err := writer.file.Close()
	writer.file = nil
	return err
}
