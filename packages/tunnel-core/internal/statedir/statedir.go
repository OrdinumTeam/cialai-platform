// SPDX-License-Identifier: Apache-2.0
// Package statedir owns private paths, atomic state writes and the process lock
// used by one tunnel sidecar at a time.
package statedir

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var ErrLocked = errors.New("tunnel state is already owned by a live process")

type Paths struct {
	Root        string
	TSNet       string
	Devices     string
	Identity    string
	IdentityKey string
	Tor         string
	OnionKey    string
	PairLock    string
	Log         string
	PID         string
}

func Prepare(root string) (Paths, error) {
	if !filepath.IsAbs(root) {
		return Paths{}, errors.New("state directory must be absolute")
	}
	root = filepath.Clean(root)
	paths := Paths{
		Root:     root,
		TSNet:    filepath.Join(root, "tsnet"),
		Devices:  filepath.Join(root, "devices.json"),
		Identity: filepath.Join(root, "identity.json"),
		// IdentityKey holds the Ed25519 seed; identity.json v2 carries only public data.
		IdentityKey: filepath.Join(root, "identity.key"),
		Tor:         filepath.Join(root, "tor"),
		OnionKey:    filepath.Join(root, "tor", "onion.key"),
		PairLock:    filepath.Join(root, "pair.lock"),
		Log:         filepath.Join(root, "tunnel.log"),
		PID:         filepath.Join(root, "pid"),
	}
	for _, path := range []string{paths.Root, paths.TSNet} {
		if err := privateDir(path); err != nil {
			return Paths{}, err
		}
	}
	return paths, nil
}

func privateDir(path string) error {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("state path cannot be a symbolic link: %s", path)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create private state directory: %w", err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("protect state directory: %w", err)
	}
	return nil
}

func (paths Paths) contains(path string) bool {
	relative, err := filepath.Rel(paths.Root, filepath.Clean(path))
	return err == nil && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (paths Paths) WriteAtomic(path string, data []byte) error {
	if !paths.contains(path) {
		return errors.New("state write escaped the owned directory")
	}
	parent := filepath.Dir(path)
	if err := privateDir(parent); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(parent, ".cialai-state-*")
	if err != nil {
		return fmt.Errorf("create temporary state file: %w", err)
	}
	temporaryPath := temporary.Name()
	clean := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		clean()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		clean()
		return fmt.Errorf("write temporary state file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		clean()
		return fmt.Errorf("sync temporary state file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("close temporary state file: %w", err)
	}
	if err := Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("replace state file: %w", err)
	}
	return nil
}

type lockRecord struct {
	PID   int    `json:"pid"`
	Nonce string `json:"nonce"`
}

type Lock struct {
	path  string
	nonce string
}

func Acquire(paths Paths, pid int, alive func(int) bool) (*Lock, error) {
	if pid <= 0 || alive == nil || !paths.contains(paths.PID) {
		return nil, errors.New("valid pid and liveness check are required")
	}
	for range 4 {
		nonce, err := randomNonce()
		if err != nil {
			return nil, err
		}
		record := lockRecord{PID: pid, Nonce: nonce}
		file, err := os.OpenFile(paths.PID, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			encoder := json.NewEncoder(file)
			if encodeErr := encoder.Encode(record); encodeErr != nil {
				_ = file.Close()
				_ = os.Remove(paths.PID)
				return nil, encodeErr
			}
			if syncErr := file.Sync(); syncErr != nil {
				_ = file.Close()
				_ = os.Remove(paths.PID)
				return nil, syncErr
			}
			if closeErr := file.Close(); closeErr != nil {
				_ = os.Remove(paths.PID)
				return nil, closeErr
			}
			return &Lock{path: paths.PID, nonce: nonce}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("create state lock: %w", err)
		}
		owner, same, err := readLock(paths.PID)
		if err == nil && owner.PID > 0 && alive(owner.PID) {
			return nil, fmt.Errorf("%w: pid %d", ErrLocked, owner.PID)
		}
		if same != nil {
			current, statErr := os.Stat(paths.PID)
			if statErr == nil && !os.SameFile(same, current) {
				continue
			}
		}
		if err := os.Remove(paths.PID); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("remove stale state lock: %w", err)
		}
	}
	return nil, errors.New("state lock changed during acquisition")
}

func readLock(path string) (lockRecord, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return lockRecord{}, nil, err
	}
	defer file.Close()
	info, statErr := file.Stat()
	if statErr != nil {
		return lockRecord{}, nil, statErr
	}
	data, err := io.ReadAll(io.LimitReader(file, 4096))
	if err != nil {
		return lockRecord{}, info, err
	}
	var record lockRecord
	if err := json.Unmarshal(data, &record); err != nil || record.PID <= 0 || record.Nonce == "" {
		return lockRecord{}, info, errors.New("invalid state lock")
	}
	return record, info, nil
}

func randomNonce() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("create lock nonce: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

func (lock *Lock) Release() error {
	if lock == nil || lock.path == "" {
		return nil
	}
	record, _, err := readLock(lock.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read state lock for release: %w", err)
	}
	if record.Nonce != lock.nonce {
		return nil
	}
	if err := os.Remove(lock.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("release state lock: %w", err)
	}
	lock.path = ""
	return nil
}

func ParsePID(data []byte) (int, error) {
	value := strings.TrimSpace(string(data))
	if pid, err := strconv.Atoi(value); err == nil && pid > 0 {
		return pid, nil
	}
	var record lockRecord
	if err := json.Unmarshal(data, &record); err != nil || record.PID <= 0 {
		return 0, errors.New("invalid pid file")
	}
	return record.PID, nil
}
