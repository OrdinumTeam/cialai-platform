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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/statedir"
)

const (
	TokenRotationInterval = 30 * 24 * time.Hour
	PreviousTokenWindow   = 24 * time.Hour
	RevokedRetention      = 30 * 24 * time.Hour
	maxRegistryBytes      = 1 << 20
)

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
	NodeKey    string
	NodeID     string
	UserID     string
	IP4        string
	RemoteAddr string
}

type Device struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Model          string     `json:"model"`
	Platform       string     `json:"platform"`
	App            string     `json:"app"`
	NodeKey        string     `json:"nodeKey"`
	NodeID         string     `json:"nodeId"`
	UserID         string     `json:"userId"`
	IP4            string     `json:"ip4"`
	TokenIssuedAt  time.Time  `json:"tokenIssuedAt"`
	TokenRotatedAt *time.Time `json:"tokenRotatedAt,omitempty"`
	PairedAt       time.Time  `json:"pairedAt"`
	LastSeenAt     time.Time  `json:"lastSeenAt"`
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

func OpenRegistry(paths statedir.Paths, identity DesktopIdentity, now func() time.Time, random io.Reader) (*Registry, error) {
	if !validEncodedID(identity.ID, "d_", 16) || !validName(identity.Name, 48) || identity.CreatedAt.IsZero() {
		return nil, errors.New("valid desktop identity is required")
	}
	if now == nil {
		now = time.Now
	}
	if random == nil {
		random = rand.Reader
	}
	registry := &Registry{paths: paths, now: now, random: random, file: registryFile{Version: 1, Desktop: identity, Devices: []deviceRecord{}}}
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
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&registry.file); err != nil {
		return nil, fmt.Errorf("decode device registry: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("device registry contains trailing data")
	}
	if registry.file.Version != 1 || registry.file.Desktop.ID != identity.ID || registry.file.Devices == nil {
		return nil, errors.New("device registry version or desktop identity does not match")
	}
	registry.file.Desktop.Name = identity.Name
	if err := registry.validateRecords(); err != nil {
		return nil, err
	}
	return registry, nil
}

func (registry *Registry) validateRecords() error {
	ids := make(map[string]bool, len(registry.file.Devices))
	keys := make(map[string]bool, len(registry.file.Devices))
	for _, device := range registry.file.Devices {
		if !validEncodedID(device.ID, "dev_", 16) || !nodeKeyPattern.MatchString(device.NodeKey) || !validHash(device.TokenHash) || ids[device.ID] || keys[device.NodeKey] {
			return errors.New("device registry contains an invalid or duplicate record")
		}
		if device.TokenPrevHash != nil && !validHash(*device.TokenPrevHash) {
			return errors.New("device registry contains an invalid previous token hash")
		}
		ids[device.ID] = true
		keys[device.NodeKey] = true
	}
	return nil
}

func (registry *Registry) Pair(input DeviceInput) (Device, string, error) {
	if err := validateDeviceInput(input); err != nil {
		return Device{}, "", err
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	now := registry.now().UTC()
	index := -1
	for candidate := range registry.file.Devices {
		if registry.file.Devices[candidate].NodeKey == input.NodeKey {
			index = candidate
			break
		}
	}
	deviceID := ""
	if index >= 0 {
		deviceID = registry.file.Devices[index].ID
	} else {
		var err error
		deviceID, err = registry.uniqueDeviceIDLocked()
		if err != nil {
			return Device{}, "", err
		}
	}
	token, hash, err := registry.issueTokenLocked(deviceID)
	if err != nil {
		return Device{}, "", err
	}
	device := Device{
		ID: deviceID, Name: input.Name, Model: input.Model, Platform: input.Platform, App: input.App,
		NodeKey: input.NodeKey, NodeID: input.NodeID, UserID: input.UserID, IP4: input.IP4,
		TokenIssuedAt: now, LastSeenAt: now, LastRemoteAddr: input.RemoteAddr,
	}
	if index >= 0 {
		device.PairedAt = registry.file.Devices[index].PairedAt
	} else {
		device.PairedAt = now
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

func validateDeviceInput(input DeviceInput) error {
	if !validName(input.Name, 48) || !validName(input.Model, 64) || !regexpToken(input.Platform, 16) || !validName(input.App, 32) || !nodeKeyPattern.MatchString(input.NodeKey) {
		return errors.New("invalid device identity")
	}
	if _, err := strconv.ParseUint(input.NodeID, 10, 64); err != nil || input.NodeID == "0" {
		return errors.New("invalid device node id")
	}
	if _, err := strconv.ParseUint(input.UserID, 10, 64); err != nil || input.UserID == "0" {
		return errors.New("invalid device user id")
	}
	ip := net.ParseIP(input.IP4)
	if ip == nil || ip.To4() == nil {
		return errors.New("invalid device IPv4 address")
	}
	if input.RemoteAddr != "" {
		if _, _, err := net.SplitHostPort(input.RemoteAddr); err != nil {
			return errors.New("invalid device remote address")
		}
	}
	return nil
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

func (registry *Registry) uniqueDeviceIDLocked() (string, error) {
	for range 8 {
		deviceID, err := randomEncoded(registry.random, "dev_", 16)
		if err != nil {
			return "", err
		}
		found := false
		for _, existing := range registry.file.Devices {
			if existing.ID == deviceID {
				found = true
				break
			}
		}
		if !found {
			return deviceID, nil
		}
	}
	return "", errors.New("could not create a unique device id")
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

func (registry *Registry) Authenticate(token string) (Device, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "cdt1" || !validEncodedID(parts[1], "dev_", 16) || !validRawURLBytes(parts[2], 32) {
		return Device{}, false
	}
	presentedHash := tokenHash(token)
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for index := range registry.file.Devices {
		device := &registry.file.Devices[index]
		if device.ID != parts[1] || device.Revoked {
			continue
		}
		accepted := hashesEqual(device.TokenHash, presentedHash)
		if !accepted && device.TokenPrevHash != nil && device.PrevValidUntil != nil && registry.now().Before(*device.PrevValidUntil) {
			accepted = hashesEqual(*device.TokenPrevHash, presentedHash)
		}
		if accepted {
			return device.Device, true
		}
		return Device{}, false
	}
	return Device{}, false
}

func (registry *Registry) TokenRotationDue(deviceID string) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for _, device := range registry.file.Devices {
		if device.ID == deviceID && !device.Revoked {
			return !registry.now().Before(device.TokenIssuedAt.Add(TokenRotationInterval))
		}
	}
	return false
}

func (registry *Registry) RotateToken(deviceID string) (string, error) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for index := range registry.file.Devices {
		device := &registry.file.Devices[index]
		if device.ID != deviceID || device.Revoked {
			continue
		}
		token, hash, err := registry.issueTokenLocked(deviceID)
		if err != nil {
			return "", err
		}
		now := registry.now().UTC()
		validUntil := now.Add(PreviousTokenWindow)
		previousHash := device.TokenHash
		previous := cloneRegistry(registry.file)
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
	return "", errors.New("active device not found")
}

// RequestTokenRotation marks a device so the edge generates and returns the
// replacement only inside its next successful encrypted upgrade.
func (registry *Registry) RequestTokenRotation(deviceID string) error {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for index := range registry.file.Devices {
		if registry.file.Devices[index].ID == deviceID && !registry.file.Devices[index].Revoked {
			previous := cloneRegistry(registry.file)
			registry.file.Devices[index].TokenIssuedAt = time.Unix(0, 0).UTC()
			if err := registry.persistLocked(); err != nil {
				registry.file = previous
				return err
			}
			return nil
		}
	}
	return errors.New("active device not found")
}

func (registry *Registry) Rename(deviceID, name string) error {
	if !validName(name, 48) {
		return errors.New("invalid device name")
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for index := range registry.file.Devices {
		if registry.file.Devices[index].ID == deviceID {
			previous := cloneRegistry(registry.file)
			registry.file.Devices[index].Name = name
			if err := registry.persistLocked(); err != nil {
				registry.file = previous
				return err
			}
			return nil
		}
	}
	return errors.New("device not found")
}

func (registry *Registry) MarkSeen(deviceID, remoteAddr string) error {
	if _, _, err := net.SplitHostPort(remoteAddr); err != nil {
		return errors.New("invalid device remote address")
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for index := range registry.file.Devices {
		if registry.file.Devices[index].ID == deviceID && !registry.file.Devices[index].Revoked {
			previous := cloneRegistry(registry.file)
			registry.file.Devices[index].LastSeenAt = registry.now().UTC()
			registry.file.Devices[index].LastRemoteAddr = remoteAddr
			if err := registry.persistLocked(); err != nil {
				registry.file = previous
				return err
			}
			return nil
		}
	}
	return errors.New("active device not found")
}

func (registry *Registry) Revoke(deviceID string) error {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for index := range registry.file.Devices {
		if registry.file.Devices[index].ID == deviceID {
			previous := cloneRegistry(registry.file)
			now := registry.now().UTC()
			registry.file.Devices[index].Revoked = true
			registry.file.Devices[index].RevokedAt = &now
			if err := registry.persistLocked(); err != nil {
				registry.file = previous
				return err
			}
			return nil
		}
	}
	return errors.New("device not found")
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
	for _, device := range registry.file.Devices {
		if device.ID == deviceID {
			return device.Device, true
		}
	}
	return Device{}, false
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
