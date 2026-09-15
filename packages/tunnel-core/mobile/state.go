// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const (
	mobileStateFile     = "mobile-state.json"
	stateVersion        = 2
	legacyStateVersion  = 1
	maxMobileStateBytes = 1 << 20
)

// legacyDirectories held the tsnet state of the Headscale-era profiles.
var legacyDirectories = []string{"profiles", "tsnet"}

// storedDesktop is the non-secret memory of one paired desktop: the pinned
// key, the onion and the candidates of its reach card. The device token lives
// only in the native secure store.
type storedDesktop struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	PublicKey   string              `json:"publicKey"`
	Fingerprint string              `json:"fingerprint"`
	Onion       string              `json:"onion"`
	Candidates  []pairing.Candidate `json:"candidates"`
	// CandidatesIssuedAt dates the candidates, which stop being dialed
	// candidates.DefaultCardTTL later; the key and the onion never expire.
	CandidatesIssuedAt time.Time `json:"candidatesIssuedAt"`
	PairedAt           time.Time `json:"pairedAt"`
	LastSeenAt         time.Time `json:"lastSeenAt"`
	LastTransport      string    `json:"lastTransport"`
}

type stateFile struct {
	Version  int                      `json:"version"`
	Desktops map[string]storedDesktop `json:"desktops"`
}

// card rebuilds the reach card the path manager dials.
func (desktop storedDesktop) card() (candidates.Card, error) {
	card := candidates.Card{
		Version:    candidates.CardVersion,
		Desktop:    pairing.Desktop{ID: desktop.ID, Name: desktop.Name, PublicKey: desktop.PublicKey},
		Onion:      desktop.Onion,
		Candidates: desktop.Candidates,
		IssuedAt:   desktop.CandidatesIssuedAt,
		ExpiresAt:  desktop.CandidatesIssuedAt.Add(candidates.DefaultCardTTL),
	}
	if card.Candidates == nil {
		card.Candidates = []pairing.Candidate{}
	}
	if err := card.Validate(); err != nil {
		return candidates.Card{}, err
	}
	return card, nil
}

func (desktop storedDesktop) validate() error {
	card, err := desktop.card()
	if err != nil {
		return err
	}
	public, err := identity.ParsePublicKey(card.Desktop.PublicKey)
	if err != nil || desktop.Fingerprint != identity.Fingerprint(public) {
		return errors.New("stored desktop fingerprint does not match its key")
	}
	if desktop.PairedAt.IsZero() {
		return errors.New("stored desktop has no pairing time")
	}
	return nil
}

// prepareRoot creates the private state directory. It must be absolute and
// may not be a symbolic link.
func prepareRoot(root string) (statedir.Paths, error) {
	if !filepath.IsAbs(root) {
		return statedir.Paths{}, errors.New("state directory must be absolute")
	}
	root = filepath.Clean(root)
	if info, err := os.Lstat(root); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return statedir.Paths{}, errors.New("state directory cannot be a symbolic link")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return statedir.Paths{}, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return statedir.Paths{}, fmt.Errorf("create state directory: %w", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return statedir.Paths{}, fmt.Errorf("protect state directory: %w", err)
	}
	return statedir.Paths{Root: root}, nil
}

// loadState reads mobile-state.json. Version 1, from the Headscale era, is
// discarded with its tsnet directories and reported through legacy.
func loadState(paths statedir.Paths) (desktops map[string]storedDesktop, legacy bool, err error) {
	desktops = map[string]storedDesktop{}
	raw, err := os.ReadFile(filepath.Join(paths.Root, mobileStateFile))
	if errors.Is(err, os.ErrNotExist) {
		return desktops, false, nil
	}
	if err != nil {
		return nil, false, coded("state_read_failed", err)
	}
	if len(raw) > maxMobileStateBytes {
		return nil, false, codedMessage("state_invalid", "O estado do celular excede o tamanho permitido.")
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return nil, false, codedMessage("state_invalid", "O estado do celular está corrompido.")
	}
	switch header.Version {
	case legacyStateVersion:
		if err := discardLegacy(paths); err != nil {
			return nil, false, err
		}
		return desktops, true, nil
	case stateVersion:
	default:
		return nil, false, codedMessage("state_invalid", "O estado do celular é de uma versão desconhecida.")
	}
	var stored stateFile
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil || stored.Desktops == nil {
		return nil, false, codedMessage("state_invalid", "O estado do celular está corrompido.")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, false, codedMessage("state_invalid", "O estado do celular contém dados adicionais.")
	}
	for id, desktop := range stored.Desktops {
		if id != desktop.ID || desktop.validate() != nil {
			return nil, false, codedMessage("state_invalid", "O estado do celular contém um computador inválido.")
		}
		desktops[id] = desktop
	}
	return desktops, false, nil
}

// discardLegacy removes the tsnet state of version 1 and leaves an empty
// version 2 file, so the discard is reported once.
func discardLegacy(paths statedir.Paths) error {
	for _, name := range legacyDirectories {
		target := filepath.Join(paths.Root, name)
		if !pathInside(paths.Root, target) {
			return codedMessage("state_invalid", "O diretório do estado antigo não é seguro.")
		}
		if err := os.RemoveAll(target); err != nil {
			return coded("state_legacy_discard_failed", err)
		}
	}
	return writeState(paths, map[string]storedDesktop{})
}

func writeState(paths statedir.Paths, desktops map[string]storedDesktop) error {
	raw, err := json.MarshalIndent(stateFile{Version: stateVersion, Desktops: desktops}, "", "  ")
	if err != nil {
		return coded("state_write_failed", err)
	}
	if err := paths.WriteAtomic(filepath.Join(paths.Root, mobileStateFile), append(raw, '\n')); err != nil {
		return coded("state_write_failed", err)
	}
	return nil
}

func pathInside(root, target string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
