package brotoclient

import (
	"encoding/json"
	"errors"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"os"
	"path/filepath"
)

type Policy struct {
	AllowFiles         bool     `json:"allowFiles"`
	FileRoots          []string `json:"fileRoots"`
	MaxFileMB          int64    `json:"maxFileMB"`
	MaxDurationMinutes int      `json:"maxDurationMinutes"`
	AllowExec          bool     `json:"allowExec"`
	AllowPTY           bool     `json:"allowPTY"`
	Dir                string   `json:"dir"`
	Shell              string   `json:"shell"`
}
type savedHost struct {
	Card     candidates.Card `json:"card"`
	Token    string          `json:"token"`
	DeviceID string          `json:"deviceId"`
}

func DefaultDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "CialaiBroto"), nil
}
func loadPolicy(paths statedir.Paths) (Policy, error) {
	home, homeErr := os.UserHomeDir()
	p := Policy{AllowFiles: true, MaxFileMB: 512, MaxDurationMinutes: 30, AllowExec: true, AllowPTY: true, Dir: home}
	if homeErr != nil {
		return p, homeErr
	}
	path := filepath.Join(paths.Root, "policy.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	err = json.Unmarshal(raw, &p)
	if err == nil && (p.MaxDurationMinutes <= 0 || p.MaxDurationMinutes > 1440 || p.MaxFileMB <= 0 || p.MaxFileMB > 1<<20) {
		return p, errors.New("invalid local duration or file limit")
	}
	if p.Dir == "" {
		p.Dir = home
	}
	return p, err
}
func loadHost(paths statedir.Paths) (*savedHost, error) {
	raw, err := os.ReadFile(filepath.Join(paths.Root, "host.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var h savedHost
	if err = json.Unmarshal(raw, &h); err != nil {
		return nil, errors.New("invalid host state")
	}
	if err = h.Card.Validate(); err != nil {
		return nil, err
	}
	if h.Token == "" || h.DeviceID == "" {
		return nil, errors.New("invalid host credential")
	}
	return &h, nil
}
func saveHost(paths statedir.Paths, h *savedHost) error {
	if h == nil {
		err := os.Remove(filepath.Join(paths.Root, "host.json"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	return paths.WriteAtomic(filepath.Join(paths.Root, "host.json"), raw)
}
