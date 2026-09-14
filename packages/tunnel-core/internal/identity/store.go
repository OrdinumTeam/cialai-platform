// SPDX-License-Identifier: Apache-2.0
package identity

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	KeyFileName    = "identity.key"
	RecordFileName = "identity.json"
	RecordVersion  = 2
	maxKeyBytes    = 256
	maxRecordBytes = 1 << 16
)

// Record is identity.json v2. It holds public data only, so it can be read by
// diagnostics without exposing the seed kept in identity.key.
type Record struct {
	Version   int       `json:"version"`
	Role      Role      `json:"role"`
	ID        string    `json:"id"`
	Name      string    `json:"name,omitempty"`
	PublicKey string    `json:"publicKey"`
	CreatedAt time.Time `json:"createdAt"`
}

type Options struct {
	Role Role
	// Dir holds identity.key and identity.json; it must already be private.
	Dir    string
	Name   string
	Now    func() time.Time
	Random io.Reader
}

// Open loads the identity in Dir or creates it on first use. A corrupt or
// world-readable key is an error, never silently replaced, because a new key
// would invalidate every pairing. The record is rewritten whenever it does not
// describe the key, which also discards identity.json v1.
func Open(options Options) (*Identity, Record, bool, error) {
	if options.Dir == "" || !filepath.IsAbs(options.Dir) {
		return nil, Record{}, false, errors.New("identity directory must be absolute")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	keyPath := filepath.Join(options.Dir, KeyFileName)
	recordPath := filepath.Join(options.Dir, RecordFileName)
	identity, created, err := loadOrCreateKey(options.Role, keyPath, options.Random)
	if err != nil {
		return nil, Record{}, false, err
	}
	record, err := syncRecord(identity, recordPath, options.Name, options.Now().UTC(), created)
	if err != nil {
		return nil, Record{}, false, err
	}
	return identity, record, created, nil
}

func loadOrCreateKey(role Role, path string, random io.Reader) (*Identity, bool, error) {
	if identity, err := readKey(role, path); err == nil {
		return identity, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	fresh, err := Generate(role, random)
	if err != nil {
		return nil, false, err
	}
	encoded := []byte(base64.RawURLEncoding.EncodeToString(fresh.seed()) + "\n")
	linked, err := writeExclusive(path, encoded)
	if err != nil {
		return nil, false, err
	}
	if !linked {
		// Another opener won the race; its key is the identity.
		identity, readErr := readKey(role, path)
		return identity, false, readErr
	}
	return fresh, true, nil
}

func readKey(role Role, path string) (*Identity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: not a regular file", ErrCorrupt)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%w: got %04o", ErrPermissions, info.Mode().Perm())
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxKeyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read identity key: %w", err)
	}
	if len(raw) > maxKeyBytes {
		return nil, ErrCorrupt
	}
	seed, err := base64.RawURLEncoding.DecodeString(string(bytes.TrimSpace(raw)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, ErrCorrupt
	}
	return FromSeed(role, seed)
}

// writeExclusive publishes data at path only if nothing exists there. The
// content is synced in a temporary file first, so a crash never leaves a
// truncated key behind. It reports false when another writer got there first.
func writeExclusive(path string, data []byte) (bool, error) {
	temporary, err := writeTemporary(filepath.Dir(path), data)
	if err != nil {
		return false, err
	}
	defer os.Remove(temporary)
	if err := os.Link(temporary, path); err == nil {
		return true, nil
	} else if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	// Some filesystems refuse hard links; fall back to an exclusive create.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create identity key: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return false, fmt.Errorf("write identity key: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return false, fmt.Errorf("sync identity key: %w", err)
	}
	return true, file.Close()
}

func writeTemporary(dir string, data []byte) (string, error) {
	file, err := os.CreateTemp(dir, ".cialai-identity-*")
	if err != nil {
		return "", fmt.Errorf("create temporary identity file: %w", err)
	}
	name := file.Name()
	fail := func(err error) (string, error) {
		_ = file.Close()
		_ = os.Remove(name)
		return "", err
	}
	if err := file.Chmod(0o600); err != nil {
		return fail(fmt.Errorf("protect temporary identity file: %w", err))
	}
	if _, err := file.Write(data); err != nil {
		return fail(fmt.Errorf("write temporary identity file: %w", err))
	}
	if err := file.Sync(); err != nil {
		return fail(fmt.Errorf("sync temporary identity file: %w", err))
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("close temporary identity file: %w", err)
	}
	return name, nil
}

func syncRecord(identity *Identity, path, name string, now time.Time, created bool) (Record, error) {
	want := Record{Version: RecordVersion, Role: identity.role, ID: identity.id, Name: name, PublicKey: identity.PublicKeyString(), CreatedAt: now}
	if !created {
		if current, err := readRecord(path); err == nil && current.Version == RecordVersion && current.ID == want.ID && current.PublicKey == want.PublicKey && current.Role == want.Role {
			want.CreatedAt = current.CreatedAt
			if name == "" {
				want.Name = current.Name
			}
			if want.Name == current.Name {
				return current, nil
			}
		}
	}
	data, err := json.MarshalIndent(want, "", "  ")
	if err != nil {
		return Record{}, err
	}
	temporary, err := writeTemporary(filepath.Dir(path), append(data, '\n'))
	if err != nil {
		return Record{}, err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return Record{}, fmt.Errorf("replace identity record: %w", err)
	}
	return want, nil
}

func readRecord(path string) (Record, error) {
	file, err := os.Open(path)
	if err != nil {
		return Record{}, err
	}
	defer file.Close()
	var record Record
	if err := json.NewDecoder(io.LimitReader(file, maxRecordBytes)).Decode(&record); err != nil {
		return Record{}, err
	}
	return record, nil
}
