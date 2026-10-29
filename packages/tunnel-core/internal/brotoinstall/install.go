// SPDX-License-Identifier: Apache-2.0
// Package brotoinstall installs only authenticated immutable service payloads.
package brotoinstall

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const DefaultURL = "https://cialai.com.br/downloads/broto/latest.json"

type Config struct {
	Payload, PublicKey, RootDir, URL, HomeDir, StateDir string
	Activate                                            bool
	Headless, Linger                                    bool
	CheckBinary                                         func(context.Context, string) error
	Run                                                 func(context.Context, Command) error
}
type Command struct {
	Program string   `json:"program"`
	Args    []string `json:"args"`
}
type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type Result struct {
	Root, Binary, Version string
	Files                 []File
	Commands              []Command
	Activated             bool
}

func DefaultRoot() (string, error) {
	dir, e := os.UserConfigDir()
	return filepath.Join(dir, "CialaiBroto", "install"), e
}
func Verify(ctx context.Context, payload, key string) (brotoupdate.Release, error) {
	var release brotoupdate.Release
	if key == "" {
		return release, errors.New("independent public key required")
	}
	if e := brotoupdate.VerifySignature(ctx, filepath.Join(payload, "SHA256SUMS.txt"), filepath.Join(payload, "SHA256SUMS.txt.minisig"), key); e != nil {
		return release, e
	}
	manifest, e := os.ReadFile(filepath.Join(payload, "SHA256SUMS.txt"))
	if e != nil {
		return release, e
	}
	if len(manifest) > 4<<20 {
		return release, errors.New("manifest too large")
	}
	entries := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(manifest)), "\n") {
		parts := strings.SplitN(line, "  ", 2)
		if len(parts) != 2 || len(parts[0]) != 64 {
			return release, errors.New("invalid checksum manifest")
		}
		if _, e = hex.DecodeString(parts[0]); e != nil {
			return release, e
		}
		name := parts[1]
		clean := filepath.Clean(filepath.FromSlash(name))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || strings.Contains(name, "\\") || strings.Contains(name, ":") || entries[name] != "" {
			return release, errors.New("invalid checksum path")
		}
		entries[name] = parts[0]
	}
	total := int64(0)
	e = filepath.WalkDir(payload, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("payload symlinks forbidden")
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("special payload file forbidden")
		}
		name, e := filepath.Rel(payload, path)
		if e != nil {
			return e
		}
		name = filepath.ToSlash(name)
		if name == "SHA256SUMS.txt" || name == "SHA256SUMS.txt.minisig" {
			return nil
		}
		expected, ok := entries[name]
		if !ok {
			return errors.New("unsigned extra payload file")
		}
		stat, e := entry.Info()
		if e != nil {
			return e
		}
		total += stat.Size()
		if total > 512<<20 {
			return errors.New("payload too large")
		}
		f, e := os.Open(path)
		if e != nil {
			return e
		}
		h := sha256.New()
		_, e = io.Copy(h, f)
		f.Close()
		if e != nil {
			return e
		}
		if hex.EncodeToString(h.Sum(nil)) != expected {
			return errors.New("payload checksum mismatch")
		}
		delete(entries, name)
		return nil
	})
	if e != nil {
		return release, e
	}
	if len(entries) > 0 {
		return release, errors.New("payload file missing")
	}
	raw, e := os.ReadFile(filepath.Join(payload, "release.json"))
	if e != nil {
		return release, e
	}
	if json.Unmarshal(raw, &release) != nil {
		return release, errors.New("invalid payload metadata")
	}
	if brotoupdate.HostTarget() == "" || release.Target != brotoupdate.HostTarget() {
		return release, errors.New("payload platform mismatch")
	}
	expected := "cialai-broto"
	if runtime.GOOS == "windows" {
		expected += ".exe"
	}
	if release.Binary != expected || !validVersion(release.Version) {
		return release, errors.New("invalid payload release")
	}
	return release, nil
}
func validVersion(value string) bool {
	if value == "" || strings.ContainsAny(value, "/\\:\r\n\x00") || value == "." || value == ".." {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return false
		}
	}
	return true
}
func Install(ctx context.Context, c Config) (Result, error) {
	var result Result
	release, e := Verify(ctx, c.Payload, c.PublicKey)
	if e != nil {
		return result, e
	}
	if c.RootDir == "" {
		c.RootDir, e = DefaultRoot()
		if e != nil {
			return result, e
		}
	}
	c.RootDir, e = filepath.Abs(c.RootDir)
	if e != nil {
		return result, e
	}
	if c.URL == "" {
		c.URL = DefaultURL
	}
	if e = privateRoot(c.RootDir); e != nil {
		return result, e
	}
	unlock, e := brotoupdate.LockInstallation(c.RootDir)
	if e != nil {
		return result, e
	}
	defer unlock()
	binary := filepath.Join(c.Payload, release.Binary)
	if c.CheckBinary == nil {
		c.CheckBinary = checkBinary
	}
	if e = c.CheckBinary(ctx, binary); e != nil {
		return result, e
	}
	destination := filepath.Join(c.RootDir, "releases", release.Version)
	_, destinationErr := os.Lstat(destination)
	installed := destinationErr == nil
	if installed {
		saved, verifyErr := Verify(ctx, destination, c.PublicKey)
		if verifyErr != nil || saved.Version != release.Version {
			return result, errors.New("existing installation is not the same signed release")
		}
	}
	if destinationErr != nil && !os.IsNotExist(destinationErr) {
		return result, destinationErr
	}
	if !installed {

		if e = os.MkdirAll(filepath.Dir(destination), 0700); e != nil {
			return result, e
		}
		temp, e := os.MkdirTemp(filepath.Dir(destination), ".install-")
		if e != nil {
			return result, e
		}
		defer os.RemoveAll(temp)
		e = filepath.WalkDir(c.Payload, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, e := filepath.Rel(c.Payload, path)
			if e != nil {
				return e
			}
			target := filepath.Join(temp, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0700)
			}
			input, e := os.Open(path)
			if e != nil {
				return e
			}
			defer input.Close()
			stat, e := entry.Info()
			if e != nil {
				return e
			}
			mode := os.FileMode(0600)
			knownExecutable := entry.Name() == release.Binary || entry.Name() == "cialai-broto-mcp" || filepath.ToSlash(relative) == "tor/tor/tor"
			if stat.Mode()&0111 != 0 || knownExecutable {
				mode = 0700
			}
			out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if e != nil {
				return e
			}
			_, e = io.Copy(out, input)
			closeErr := out.Close()
			if e != nil {
				return e
			}
			return closeErr
		})
		if e != nil {
			return result, e
		}
		if _, e = Verify(ctx, temp, c.PublicKey); e != nil {
			return result, e
		}
		if e = c.CheckBinary(ctx, filepath.Join(temp, release.Binary)); e != nil {
			return result, e
		}
		if e = os.Rename(temp, destination); e != nil {
			return result, e
		}
	}
	result = Result{Root: c.RootDir, Binary: filepath.Join(destination, release.Binary), Version: release.Version}
	home := c.HomeDir
	if home == "" {
		home, e = os.UserHomeDir()
		if e != nil {
			return result, e
		}
	}
	stateDir := c.StateDir
	if stateDir == "" {
		configDir, err := os.UserConfigDir()
		if err != nil {
			return result, err
		}
		stateDir = filepath.Join(configDir, "CialaiBroto")
	}
	opts := planOptions{Headless: c.Headless, Linger: c.Linger, StateDir: stateDir}
	if runtime.GOOS == "darwin" && c.Headless {
		user, err := exec.Command("/usr/bin/id", "-un").Output()
		if err != nil {
			return result, err
		}
		group, err := exec.Command("/usr/bin/id", "-gn").Output()
		if err != nil {
			return result, err
		}
		opts.User = strings.TrimSpace(string(user))
		opts.Group = strings.TrimSpace(string(group))
	}
	files, commands, e := plan(runtime.GOOS, c.RootDir, result.Binary, c.PublicKey, c.URL, home, platformOwner(), opts)
	if e != nil {
		return result, e
	}
	result.Files = files
	result.Commands = commands
	if !c.Activate {
		return result, nil
	}
	// Never overwrite unrelated local service configuration. Matching partial installs are retryable.
	for _, file := range files {
		if st, err := os.Lstat(file.Path); err == nil {
			if !st.Mode().IsRegular() {
				return result, errors.New("unsafe existing configuration")
			}
			raw, err := os.ReadFile(file.Path)
			if err != nil || string(raw) != file.Content {
				return result, errors.New("different installation configuration already exists")
			}
		} else if !os.IsNotExist(err) {
			return result, err
		}
	}
	for _, file := range files {
		if _, err := os.Stat(file.Path); err == nil {
			continue
		}
		if e = os.MkdirAll(filepath.Dir(file.Path), 0700); e != nil {
			return result, e
		}
		out, err := os.OpenFile(file.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return result, err
		}
		_, err = out.WriteString(file.Content)
		closeErr := out.Close()
		if err != nil {
			return result, err
		}
		if closeErr != nil {
			return result, closeErr
		}
	}
	if c.Activate {
		run := c.Run
		if run == nil {
			run = func(ctx context.Context, cmd Command) error {
				if cmd.Program == "launchctl" && len(cmd.Args) == 3 && cmd.Args[0] == "bootstrap" {
					label := strings.TrimSuffix(filepath.Base(cmd.Args[2]), ".plist")
					if exec.CommandContext(ctx, "launchctl", "print", cmd.Args[1]+"/"+label).Run() == nil {
						return nil
					}
				}
				command := exec.CommandContext(ctx, cmd.Program, cmd.Args...)
				command.Stdout = os.Stderr
				command.Stderr = os.Stderr
				hideConsole(command)
				return command.Run()
			}
		}
		for _, cmd := range commands {
			if e = run(ctx, cmd); e != nil {
				return result, e
			}
		}
		result.Activated = true
	}
	return result, nil
}
func checkBinary(ctx context.Context, path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	for _, args := range [][]string{{"codesign", "--verify", "--deep", "--strict", path}, {"spctl", "--assess", "--type", "execute", path}} {
		if e := exec.CommandContext(ctx, args[0], args[1:]...).Run(); e != nil {
			return errors.New("macOS distribution signature assessment failed")
		}
	}
	return nil
}
