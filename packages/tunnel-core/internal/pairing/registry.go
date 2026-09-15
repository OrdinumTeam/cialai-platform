// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

const (
	RegistryVersion       = 2
	TokenRotationInterval = 30 * 24 * time.Hour
	PreviousTokenWindow   = 24 * time.Hour
	RevokedRetention      = 30 * 24 * time.Hour
	maxRegistryBytes      = 1 << 20
	legacyRegistryVersion = 1
)

// Transports a device session can arrive through, recorded as lastTransport.
const (
	TransportDirect = "direct"
	TransportTor    = "tor"
)

// ErrLegacyRegistry marks a devices.json written by the Headscale-era v1
// registry. Its devices are not migrated: the phones must pair again.
var ErrLegacyRegistry = errors.New("devices.json v1 is not supported; pair the phones again")

// The TLS layer asks the registry whether a phone key is registered.
var _ identity.KeyRegistry = (*Registry)(nil)

type DesktopIdentity struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type DeviceInput struct {
	Name       string
	Model      string
	Platform   string
	App        string
	DeviceKey  string
	Transport  string
	RemoteAddr string
}

// Device is the public view of a paired phone. Its id is derived from
// DeviceKey, the canonical base64url Ed25519 public key proven over TLS.
type Device struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Model          string     `json:"model"`
	Platform       string     `json:"platform"`
	App            string     `json:"app"`
	DeviceKey      string     `json:"deviceKey"`
	TokenIssuedAt  time.Time  `json:"tokenIssuedAt"`
	TokenRotatedAt *time.Time `json:"tokenRotatedAt,omitempty"`
	PairedAt       time.Time  `json:"pairedAt"`
	LastSeenAt     time.Time  `json:"lastSeenAt"`
	LastTransport  string     `json:"lastTransport"`
	LastRemoteAddr string     `json:"lastRemoteAddr"`
	Revoked        bool       `json:"revoked"`
	RevokedAt      *time.Time `json:"revokedAt,omitempty"`
}

type deviceRecord struct {
	Device
	TokenHash      string     `json:"tokenHash"`
	TokenPrevHash  *string    `json:"tokenPrevHash"`
	PrevValidUntil *time.Time `json:"prevValidUntil"`
}

type registryFile struct {
	Version int             `json:"version"`
	Desktop DesktopIdentity `json:"desktop"`
	Devices []deviceRecord  `json:"devices"`
}

type Registry struct {
	mu     sync.Mutex
	paths  statedir.Paths
	now    func() time.Time
	random io.Reader
	file   registryFile
}

func OpenRegistry(paths statedir.Paths, desktop DesktopIdentity, now func() time.Time, random io.Reader) (*Registry, error) {
	if !validEncodedID(desktop.ID, "d_", 16) || !validName(desktop.Name, 48) || desktop.CreatedAt.IsZero() {
		return nil, errors.New("valid desktop identity is required")
	}
	if now == nil {
		now = time.Now
	}
	if random == nil {
		random = rand.Reader
	}
	registry := &Registry{paths: paths, now: now, random: random, file: registryFile{Version: RegistryVersion, Desktop: desktop, Devices: []deviceRecord{}}}
	raw, err := os.ReadFile(paths.Devices)
	if errors.Is(err, os.ErrNotExist) {
		return registry, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read device registry: %w", err)
	}
	if len(raw) > maxRegistryBytes {
		return nil, errors.New("device registry exceeds 1 MiB")
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return nil, fmt.Errorf("decode device registry: %w", err)
	}
	if header.Version == legacyRegistryVersion {
		return nil, wrapError("registry_legacy", "Os celulares vinculados em uma versão anterior do Cialai precisam ser pareados de novo.", ErrLegacyRegistry)
	}
	if header.Version != RegistryVersion {
		return nil, fmt.Errorf("device registry version %d is not supported", header.Version)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&registry.file); err != nil {
		return nil, fmt.Errorf("decode device registry: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("device registry contains trailing data")
	}
	if registry.file.Desktop.ID != desktop.ID || registry.file.Devices == nil {
		return nil, errors.New("device registry desktop identity does not match")
	}
	registry.file.Desktop.Name = desktop.Name
	if err := registry.validateRecords(); err != nil {
		return nil, err
	}
	return registry, nil
}

func (registry *Registry) validateRecords() error {
	ids := make(map[string]bool, len(registry.file.Devices))
	for _, device := range registry.file.Devices {
		derived, keyErr := deviceIDForKey(device.DeviceKey)
		if keyErr != nil || device.ID != derived || !validHash(device.TokenHash) || ids[device.ID] {
			return errors.New("device registry contains an invalid or duplicate record")
		}
		if !validTransport(device.LastTransport) || !validRemoteAddr(device.LastRemoteAddr) {
			return errors.New("device registry contains an invalid last transport")
		}
		if device.TokenPrevHash != nil && !validHash(*device.TokenPrevHash) {
			return errors.New("device registry contains an invalid previous token hash")
		}
		ids[device.ID] = true
	}
	return nil
}

func deviceIDForKey(deviceKey string) (string, error) {
	public, err := identity.ParsePublicKey(deviceKey)
	if err != nil {
		return "", err
	}
	return identity.DeriveID(identity.RolePhone, public)
}

// Pair records a phone whose key was proven over TLS and whose pairing session
// was consumed. Pairing the same key again keeps the device id and pairedAt,
// clears a revocation and replaces the token.
func (registry *Registry) Pair(input DeviceInput) (Device, string, error) {
	deviceID, err := validateDeviceInput(input)
	if err != nil {
		return Device{}, "", err
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	now := registry.now().UTC()
	index := registry.indexLocked(deviceID)
	token, hash, err := registry.issueTokenLocked(deviceID)
	if err != nil {
		return Device{}, "", err
	}
	device := Device{
		ID: deviceID, Name: input.Name, Model: input.Model, Platform: input.Platform, App: input.App,
		DeviceKey: input.DeviceKey, TokenIssuedAt: now, PairedAt: now, LastSeenAt: now,
		LastTransport: input.Transport, LastRemoteAddr: input.RemoteAddr,
	}
	if index >= 0 {
		device.PairedAt = registry.file.Devices[index].PairedAt
	}
	record := deviceRecord{Device: device, TokenHash: hash}
	previous := cloneRegistry(registry.file)
	if index >= 0 {
		registry.file.Devices[index] = record
	} else {
		registry.file.Devices = append(registry.file.Devices, record)
	}
	if err := registry.persistLocked(); err != nil {
		registry.file = previous
		return Device{}, "", err
	}
	return device, token, nil
}

func validateDeviceInput(input DeviceInput) (string, error) {
	if !validName(input.Name, 48) || !validName(input.Model, 64) || !regexpToken(input.Platform, 16) || !validName(input.App, 32) {
		return "", errors.New("invalid device identity")
	}
	deviceID, err := deviceIDForKey(input.DeviceKey)
	if err != nil {
		return "", errors.New("invalid device public key")
	}
	if !validTransport(input.Transport) || !validRemoteAddr(input.RemoteAddr) {
		return "", errors.New("invalid device transport or remote address")
	}
	return deviceID, nil
}

func validTransport(transport string) bool {
	return transport == TransportDirect || transport == TransportTor
}

// validRemoteAddr accepts an empty value, used by sessions arriving through the
// local Tor process, or a host:port pair.
func validRemoteAddr(remoteAddr string) bool {
	if remoteAddr == "" {
		return true
	}
	if len(remoteAddr) > 128 || hasControl(remoteAddr) {
		return false
	}
	_, _, err := net.SplitHostPort(remoteAddr)
	return err == nil
}

func regexpToken(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
	}
	return true
}

func (registry *Registry) indexLocked(deviceID string) int {
	for index := range registry.file.Devices {
		if registry.file.Devices[index].ID == deviceID {
			return index
		}
	}
	return -1
}

func (registry *Registry) activeLocked(deviceID string) *deviceRecord {
	index := registry.indexLocked(deviceID)
	if index < 0 || registry.file.Devices[index].Revoked {
		return nil
	}
	return &registry.file.Devices[index]
}

func (registry *Registry) issueTokenLocked(deviceID string) (string, string, error) {
	secret, err := randomEncoded(registry.random, "", 32)
	if err != nil {
		return "", "", err
	}
	token := "cdt1." + deviceID + "." + secret
	return token, tokenHash(token), nil
}

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func validHash(value string) bool {
	if !strings.HasPrefix(value, "sha256:") {
		return false
	}
	decoded, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil && len(decoded) == sha256.Size
}

func hashesEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// RegisteredKey implements identity.KeyRegistry: it maps a canonical phone
// public key to its device id, only while the device is not revoked.
func (registry *Registry) RegisteredKey(publicKey string) (string, bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for _, device := range registry.file.Devices {
		if device.DeviceKey == publicKey && !device.Revoked {
			return device.ID, true
		}
	}
	return "", false
}

// RevokedKey reports whether publicKey belongs to a revoked device that was not
// paired again, so a transport can tell the phone that it was removed. It
// implements transport.RevocationList; pruned devices are forgotten.
func (registry *Registry) RevokedKey(publicKey string) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for _, device := range registry.file.Devices {
		if device.DeviceKey == publicKey {
			return device.Revoked
		}
	}
	return false
}

func (registry *Registry) Authenticate(token string) (Device, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "cdt1" || !validEncodedID(parts[1], "dev_", 16) || !validRawURLBytes(parts[2], 32) {
		return Device{}, false
	}
	presentedHash := tokenHash(token)
	registry.mu.Lock()
	defer registry.mu.Unlock()
	device := registry.activeLocked(parts[1])
	if device == nil {
		return Device{}, false
	}
	accepted := hashesEqual(device.TokenHash, presentedHash)
	if !accepted && device.TokenPrevHash != nil && device.PrevValidUntil != nil && registry.now().Before(*device.PrevValidUntil) {
		accepted = hashesEqual(*device.TokenPrevHash, presentedHash)
	}
	if !accepted {
		return Device{}, false
	}
	return device.Device, true
}

func (registry *Registry) TokenRotationDue(deviceID string) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	device := registry.activeLocked(deviceID)
	return device != nil && !registry.now().Before(device.TokenIssuedAt.Add(TokenRotationInterval))
}

func (registry *Registry) RotateToken(deviceID string) (string, error) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	device := registry.activeLocked(deviceID)
	if device == nil {
		return "", errors.New("active device not found")
	}
	token, hash, err := registry.issueTokenLocked(deviceID)
	if err != nil {
		return "", err
	}
	previous := cloneRegistry(registry.file)
	now := registry.now().UTC()
	validUntil := now.Add(PreviousTokenWindow)
	previousHash := device.TokenHash
	device.TokenPrevHash = &previousHash
	device.PrevValidUntil = &validUntil
	device.TokenHash = hash
	device.TokenIssuedAt = now
	device.TokenRotatedAt = &now
	if err := registry.persistLocked(); err != nil {
		registry.file = previous
		return "", err
	}
	return token, nil
}

// RequestTokenRotation marks a device so the edge generates and returns the
// replacement only inside its next successful authenticated upgrade.
func (registry *Registry) RequestTokenRotation(deviceID string) error {
	return registry.update(deviceID, true, func(device *deviceRecord) {
		device.TokenIssuedAt = time.Unix(0, 0).UTC()
	})
}

func (registry *Registry) Rename(deviceID, name string) error {
	if !validName(name, 48) {
		return errors.New("invalid device name")
	}
	return registry.update(deviceID, false, func(device *deviceRecord) {
		device.Name = name
	})
}

// MarkSeen records the last session of an active device: when, through which
// transport and, for direct sessions, from which remote address.
func (registry *Registry) MarkSeen(deviceID, transport, remoteAddr string) error {
	if !validTransport(transport) || !validRemoteAddr(remoteAddr) {
		return errors.New("invalid device transport or remote address")
	}
	return registry.update(deviceID, true, func(device *deviceRecord) {
		device.LastSeenAt = registry.now().UTC()
		device.LastTransport = transport
		device.LastRemoteAddr = remoteAddr
	})
}

// Revoke removes the device key from the accepted set. Revoking a device again
// keeps the first revokedAt, so a repeated revocation does not extend the
// retention.
func (registry *Registry) Revoke(deviceID string) error {
	return registry.update(deviceID, false, func(device *deviceRecord) {
		if device.Revoked {
			return
		}
		now := registry.now().UTC()
		device.Revoked = true
		device.RevokedAt = &now
	})
}

// update applies change to one device and persists it, restoring the
// previous state when the write fails.
func (registry *Registry) update(deviceID string, activeOnly bool, change func(*deviceRecord)) error {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	index := registry.indexLocked(deviceID)
	if index < 0 || (activeOnly && registry.file.Devices[index].Revoked) {
		if activeOnly {
			return errors.New("active device not found")
		}
		return errors.New("device not found")
	}
	previous := cloneRegistry(registry.file)
	change(&registry.file.Devices[index])
	if err := registry.persistLocked(); err != nil {
		registry.file = previous
		return err
	}
	return nil
}

func (registry *Registry) List() []Device {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	devices := make([]Device, len(registry.file.Devices))
	for index := range registry.file.Devices {
		devices[index] = registry.file.Devices[index].Device
	}
	return devices
}

func (registry *Registry) Get(deviceID string) (Device, bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	index := registry.indexLocked(deviceID)
	if index < 0 {
		return Device{}, false
	}
	return registry.file.Devices[index].Device, true
}

func (registry *Registry) PruneRevoked() (int, error) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	cutoff := registry.now().Add(-RevokedRetention)
	kept := make([]deviceRecord, 0, len(registry.file.Devices))
	for _, device := range registry.file.Devices {
		if device.Revoked && device.RevokedAt != nil && device.RevokedAt.Before(cutoff) {
			continue
		}
		kept = append(kept, device)
	}
	removed := len(registry.file.Devices) - len(kept)
	if removed == 0 {
		return 0, nil
	}
	previous := cloneRegistry(registry.file)
	registry.file.Devices = kept
	if err := registry.persistLocked(); err != nil {
		registry.file = previous
		return 0, err
	}
	return removed, nil
}

func (registry *Registry) persistLocked() error {
	raw, err := json.MarshalIndent(registry.file, "", "  ")
	if err != nil {
		return fmt.Errorf("encode device registry: %w", err)
	}
	raw = append(raw, '\n')
	if len(raw) > maxRegistryBytes {
		return errors.New("device registry exceeds 1 MiB")
	}
	return registry.paths.WriteAtomic(registry.paths.Devices, raw)
}

func cloneRegistry(source registryFile) registryFile {
	clone := source
	clone.Devices = append([]deviceRecord(nil), source.Devices...)
	return clone
}
