// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha3"
	"crypto/sha512"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// OnionPort is the virtual port every Cialai onion service publishes.
const OnionPort = 443

const (
	onionVersion        = 0x03
	onionChecksumPrefix = ".onion checksum"
	onionSuffix         = ".onion"
	serviceIDLength     = 56
	maxOnionKeyBytes    = 256
)

var (
	ErrOnionKeyCorrupt     = errors.New("onion key file is corrupt")
	ErrOnionKeyPermissions = errors.New("onion key file must be private (0600)")
	ErrInvalidOnionAddress = errors.New("invalid onion v3 address")
)

var serviceIDEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// OnionKey is the persistent ED25519-V3 key of the desktop onion service. It
// is deliberately separate from the device identity: the single-hop service is
// not anonymous, so its key must never be reused anywhere else.
type OnionKey struct {
	seed      []byte
	public    ed25519.PublicKey
	serviceID string
}

// GenerateOnionKey creates a fresh onion service key.
func GenerateOnionKey(random io.Reader) (*OnionKey, error) {
	if random == nil {
		random = rand.Reader
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(random, seed); err != nil {
		return nil, fmt.Errorf("generate onion key: %w", err)
	}
	return OnionKeyFromSeed(seed)
}

// OnionKeyFromSeed rebuilds the key from its 32-byte Ed25519 seed.
func OnionKeyFromSeed(seed []byte) (*OnionKey, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, ErrOnionKeyCorrupt
	}
	public := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	return &OnionKey{
		seed:      bytes.Clone(seed),
		public:    public,
		serviceID: serviceIDFromPublicKey(public),
	}, nil
}

// PublicKey returns a copy of the service public key.
func (key *OnionKey) PublicKey() ed25519.PublicKey {
	return bytes.Clone(key.public)
}

// ServiceID is the 56-character v3 service id, without ".onion".
func (key *OnionKey) ServiceID() string {
	return key.serviceID
}

// Address is the host name clients dial through SOCKS.
func (key *OnionKey) Address() string {
	return key.serviceID + onionSuffix
}

// torBlob is the ADD_ONION ED25519-V3 blob: base64 of Tor's 64-byte expanded
// secret key, the clamped SHA-512 of the seed. Callers must never log it.
func (key *OnionKey) torBlob() string {
	digest := sha512.Sum512(key.seed)
	digest[0] &= 248
	digest[31] &= 127
	digest[31] |= 64
	blob := base64.StdEncoding.EncodeToString(digest[:])
	clear(digest[:])
	return blob
}

// serviceIDFromPublicKey follows rend-spec-v3: base32(PUBKEY | CHECKSUM |
// VERSION), where CHECKSUM is the first two bytes of
// SHA3-256(".onion checksum" | PUBKEY | VERSION).
func serviceIDFromPublicKey(public ed25519.PublicKey) string {
	checksum := onionChecksum(public)
	raw := make([]byte, 0, ed25519.PublicKeySize+3)
	raw = append(raw, public...)
	raw = append(raw, checksum[0], checksum[1], onionVersion)
	return strings.ToLower(serviceIDEncoding.EncodeToString(raw))
}

func onionChecksum(public []byte) [32]byte {
	input := make([]byte, 0, len(onionChecksumPrefix)+len(public)+1)
	input = append(input, onionChecksumPrefix...)
	input = append(input, public...)
	input = append(input, onionVersion)
	return sha3.Sum256(input)
}

// ParseOnionAddress validates a v3 onion host name, "<56 base32>.onion" in any
// case, and returns its canonical lower-case form and service public key.
func ParseOnionAddress(host string) (string, ed25519.PublicKey, error) {
	lower := strings.ToLower(host)
	id, ok := strings.CutSuffix(lower, onionSuffix)
	if !ok || len(id) != serviceIDLength {
		return "", nil, ErrInvalidOnionAddress
	}
	raw, err := serviceIDEncoding.DecodeString(strings.ToUpper(id))
	if err != nil || len(raw) != ed25519.PublicKeySize+3 || raw[34] != onionVersion {
		return "", nil, ErrInvalidOnionAddress
	}
	public := ed25519.PublicKey(raw[:ed25519.PublicKeySize])
	checksum := onionChecksum(public)
	if raw[32] != checksum[0] || raw[33] != checksum[1] {
		return "", nil, ErrInvalidOnionAddress
	}
	return id + onionSuffix, bytes.Clone(public), nil
}

// LoadOrCreateOnionKey reads the key at path or creates it on first use. A
// corrupt or readable-by-others key is an error and is never replaced, since a
// new key would change the onion address carried by every pairing.
func LoadOrCreateOnionKey(path string, random io.Reader) (*OnionKey, bool, error) {
	if !filepath.IsAbs(path) {
		return nil, false, errors.New("onion key path must be absolute")
	}
	if key, err := readOnionKey(path); err == nil {
		return key, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	if err := privateDirectory(filepath.Dir(path)); err != nil {
		return nil, false, err
	}
	fresh, err := GenerateOnionKey(random)
	if err != nil {
		return nil, false, err
	}
	encoded := []byte(base64.RawURLEncoding.EncodeToString(fresh.seed) + "\n")
	published, err := publishExclusive(path, encoded)
	if err != nil {
		return nil, false, err
	}
	if !published {
		key, readErr := readOnionKey(path)
		return key, false, readErr
	}
	return fresh, true, nil
}

func readOnionKey(path string) (*OnionKey, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: not a regular file", ErrOnionKeyCorrupt)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%w: got %04o", ErrOnionKeyPermissions, info.Mode().Perm())
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxOnionKeyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read onion key: %w", err)
	}
	if len(raw) > maxOnionKeyBytes {
		return nil, ErrOnionKeyCorrupt
	}
	seed, err := base64.RawURLEncoding.DecodeString(string(bytes.TrimSpace(raw)))
	if err != nil {
		return nil, ErrOnionKeyCorrupt
	}
	defer clear(seed)
	return OnionKeyFromSeed(seed)
}

// publishExclusive makes data appear at path only when nothing exists there.
// The content is synced in a temporary file first, so a crash never leaves a
// truncated key. It reports false when another writer got there first.
func publishExclusive(path string, data []byte) (bool, error) {
	temporary, err := writePrivateTemporary(filepath.Dir(path), ".cialai-onion-*", data)
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
		return false, fmt.Errorf("create onion key: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return false, fmt.Errorf("write onion key: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return false, fmt.Errorf("sync onion key: %w", err)
	}
	return true, file.Close()
}

func writePrivateTemporary(dir, pattern string, data []byte) (string, error) {
	file, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", fmt.Errorf("create temporary file: %w", err)
	}
	name := file.Name()
	fail := func(err error) (string, error) {
		_ = file.Close()
		_ = os.Remove(name)
		return "", err
	}
	if err := file.Chmod(0o600); err != nil {
		return fail(fmt.Errorf("protect temporary file: %w", err))
	}
	if _, err := file.Write(data); err != nil {
		return fail(fmt.Errorf("write temporary file: %w", err))
	}
	if err := file.Sync(); err != nil {
		return fail(fmt.Errorf("sync temporary file: %w", err))
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("close temporary file: %w", err)
	}
	return name, nil
}

// privateDirectory creates dir as 0700 and refuses a symbolic link in its place.
func privateDirectory(dir string) error {
	if info, err := os.Lstat(dir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("tor state path cannot be a symbolic link: %s", dir)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create private tor directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("protect tor directory: %w", err)
	}
	return nil
}
