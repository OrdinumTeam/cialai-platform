// SPDX-License-Identifier: Apache-2.0
// Package brotoupdate stages authenticated Broto releases without replacing running files.
package brotoupdate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/mod/semver"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const maxArchive = 512 << 20

var ErrNoUpdate = errors.New("Broto is already up to date")

var versionPattern = regexp.MustCompile(`^(?:broto-v)?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$`)

type Asset struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type Metadata struct {
	Tag    string  `json:"tag"`
	Assets []Asset `json:"assets"`
}
type Release struct {
	Version string `json:"version"`
	Target  string `json:"target"`
	Binary  string `json:"binary"`
}
type Config struct {
	URL, PublicKey, CurrentDir, ReleasesDir, Target, CurrentPointer, StateDir string
	Client                                                                    *http.Client
	Verify                                                                    func(context.Context, string, string, string) error
	CheckBinary                                                               func(context.Context, string) error
}
type Result struct {
	Version            string `json:"version"`
	Target             string `json:"target"`
	PreviousBinary     string `json:"previousBinary"`
	NextBinary         string `json:"nextBinary"`
	ActivationRequired bool   `json:"activationRequired"`
	CurrentPointer     string `json:"currentPointer,omitempty"`
	StateDir           string `json:"stateDir,omitempty"`
}

func HostTarget() string {
	return map[string]string{"darwin/arm64": "macos-arm64", "darwin/amd64": "macos-x64", "linux/amd64": "linux-x64", "windows/amd64": "windows-x64"}[runtime.GOOS+"/"+runtime.GOARCH]
}
func verify(ctx context.Context, file, sig, key string) error {
	return VerifySignature(ctx, file, sig, key)
}
func checkBinary(ctx context.Context, path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	for _, args := range [][]string{{"codesign", "--verify", "--deep", "--strict", path}, {"spctl", "--assess", "--type", "execute", path}} {
		if e := exec.CommandContext(ctx, args[0], args[1:]...).Run(); e != nil {
			return errors.New("macOS update signature assessment failed")
		}
	}
	return nil
}
func download(ctx context.Context, client *http.Client, source, dest string, limit int64) (int64, error) {
	u, e := url.Parse(source)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return 0, errors.New("HTTPS update URL required")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", source, nil)
	if e != nil {
		return 0, e
	}
	resp, e := client.Do(req)
	if e != nil {
		return 0, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("update HTTP status %d", resp.StatusCode)
	}
	f, e := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return 0, e
	}
	n, e := io.Copy(f, io.LimitReader(resp.Body, limit+1))
	closeErr := f.Close()
	if e != nil {
		return n, e
	}
	if closeErr != nil {
		return n, closeErr
	}
	if n > limit {
		return n, errors.New("update download too large")
	}
	return n, nil
}
func Stage(ctx context.Context, c Config) (result Result, err error) {
	if c.URL == "" || c.PublicKey == "" {
		return result, errors.New("Broto update URL and independent public key must be configured")
	}
	if c.Target == "" {
		c.Target = HostTarget()
	}
	if c.Target == "" {
		return result, errors.New("unsupported update target")
	}
	currentBytes, e := os.ReadFile(filepath.Join(c.CurrentDir, "release.json"))
	if e != nil {
		return result, e
	}
	var previous Release
	if json.Unmarshal(currentBytes, &previous) != nil || previous.Target != c.Target {
		return result, errors.New("invalid current release metadata")
	}
	currentVersion := "v" + strings.TrimPrefix(previous.Version, "broto-v")
	if !semver.IsValid(currentVersion) {
		return result, errors.New("invalid current version")
	}
	if c.Verify == nil {
		c.Verify = verify
	}
	if c.CheckBinary == nil {
		c.CheckBinary = checkBinary
	}
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 || req.URL.Scheme != "https" {
				return errors.New("unsafe update redirect")
			}
			return nil
		}}
	}
	releases, e := filepath.Abs(c.ReleasesDir)
	if e != nil {
		return result, e
	}
	if e = privateDirectory(releases); e != nil {
		return result, e
	}
	stage, e := os.MkdirTemp(releases, ".broto-update-")
	if e != nil {
		return result, e
	}
	defer os.RemoveAll(stage)
	manifest := filepath.Join(stage, "latest.json")
	signature := manifest + ".minisig"
	if _, e = download(ctx, c.Client, c.URL, manifest, 1<<20); e != nil {
		return result, e
	}
	if _, e = download(ctx, c.Client, c.URL+".minisig", signature, 16384); e != nil {
		return result, e
	}
	if e = c.Verify(ctx, manifest, signature, c.PublicKey); e != nil {
		return result, e
	}
	raw, e := os.ReadFile(manifest)
	if e != nil {
		return result, e
	}
	var latest Metadata
	if json.Unmarshal(raw, &latest) != nil || !versionPattern.MatchString(latest.Tag) {
		return result, errors.New("invalid signed update metadata")
	}
	nextVersion := "v" + strings.TrimPrefix(latest.Tag, "broto-v")
	if semver.IsValid(nextVersion) && semver.Compare(nextVersion, currentVersion) == 0 {
		return result, ErrNoUpdate
	}
	if !semver.IsValid(nextVersion) || semver.Compare(nextVersion, currentVersion) <= 0 {
		return result, errors.New("update must advance version")
	}
	name := "CialaiBroto_" + c.Target + ".tar.gz"
	var selected *Asset
	for _, asset := range latest.Assets {
		if asset.Name == name {
			if selected != nil {
				return result, errors.New("duplicate update target")
			}
			v := asset
			selected = &v
		}
	}
	if selected == nil || selected.Bytes < 1 || selected.Bytes > maxArchive || len(selected.SHA256) != 64 {
		return result, errors.New("invalid update asset")
	}
	expected, e := hex.DecodeString(selected.SHA256)
	if e != nil {
		return result, e
	}
	base, e := url.Parse(c.URL)
	if e != nil {
		return result, e
	}
	assetURL, e := url.Parse(selected.URL)
	if e != nil || assetURL.Scheme != "https" || assetURL.Host != base.Host {
		return result, errors.New("update asset origin differs from signed metadata origin")
	}
	archive := filepath.Join(stage, "payload.tar.gz")
	size, e := download(ctx, c.Client, selected.URL, archive, maxArchive)
	if e != nil {
		return result, e
	}
	if size != selected.Bytes {
		return result, errors.New("update size mismatch")
	}
	file, e := os.Open(archive)
	if e != nil {
		return result, e
	}
	hash := sha256.New()
	_, e = io.Copy(hash, file)
	file.Close()
	if e != nil {
		return result, e
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), hex.EncodeToString(expected)) {
		return result, errors.New("update checksum mismatch")
	}
	payload := filepath.Join(stage, "payload")
	if e = os.Mkdir(payload, 0700); e != nil {
		return result, e
	}
	if e = extract(archive, payload); e != nil {
		return result, e
	}
	releaseBytes, e := os.ReadFile(filepath.Join(payload, "release.json"))
	if e != nil {
		return result, e
	}
	var next Release
	if json.Unmarshal(releaseBytes, &next) != nil || next.Version != latest.Tag || next.Target != c.Target {
		return result, errors.New("payload metadata mismatch")
	}
	binary := "cialai-broto"
	if c.Target == "windows-x64" {
		binary += ".exe"
	}
	if next.Binary != binary {
		return result, errors.New("invalid payload binary")
	}
	path := filepath.Join(payload, binary)
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() {
		return result, errors.New("update binary missing")
	}
	if e = c.CheckBinary(ctx, path); e != nil {
		return result, e
	}
	destination := filepath.Join(releases, latest.Tag)
	if st, statErr := os.Lstat(destination); statErr == nil {
		if !st.IsDir() {
			return result, errors.New("unsafe staged release")
		}
		expected, err := payloadDigest(payload)
		if err != nil {
			return result, err
		}
		existing, err := payloadDigest(destination)
		if err != nil || existing != expected {
			return result, errors.New("existing staged release differs from signed update")
		}
	} else if os.IsNotExist(statErr) {
		if e = os.Rename(payload, destination); e != nil {
			return result, e
		}
	} else {
		return result, statErr
	}
	return Result{Version: next.Version, Target: c.Target, PreviousBinary: filepath.Join(c.CurrentDir, binary), NextBinary: filepath.Join(destination, binary), ActivationRequired: true, CurrentPointer: c.CurrentPointer, StateDir: c.StateDir}, nil
}
func extract(archive, dest string) error {
	f, e := os.Open(archive)
	if e != nil {
		return e
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		return e
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	var total int64
	count := 0
	for {
		header, e := reader.Next()
		if e == io.EOF {
			return nil
		}
		if e != nil {
			return e
		}
		count++
		if count > 50000 {
			return errors.New("too many archive entries")
		}
		name := strings.TrimPrefix(header.Name, "./")
		if name == "" || name == "." {
			continue
		}
		clean := filepath.Clean(filepath.FromSlash(name))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || strings.Contains(name, "\\") || strings.Contains(name, ":") {
			return errors.New("unsafe update archive path")
		}
		path := filepath.Join(dest, clean)
		switch header.Typeflag {
		case tar.TypeDir:
			if e = os.MkdirAll(path, 0700); e != nil {
				return e
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > maxArchive-total {
				return errors.New("expanded update too large")
			}
			total += header.Size
			if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
				return e
			}
			mode := os.FileMode(0600)
			if header.Mode&0111 != 0 {
				mode = 0700
			}
			out, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if e != nil {
				return e
			}
			_, copyErr := io.Copy(out, reader)
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return errors.New("update archive links and special files are forbidden")
		}
	}
}

// ProtectDirectory creates or validates a private per-user installation root.
func ProtectDirectory(path string) error { return privateDirectory(path) }

func payloadDigest(root string) ([32]byte, error) {
	hash := sha256.New()
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		hash.Write([]byte(filepath.ToSlash(relative) + "\x00"))
		if entry.IsDir() {
			hash.Write([]byte("d\x00"))
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("unsafe staged payload file")
		}
		stat, err := entry.Info()
		if err != nil {
			return err
		}
		total += stat.Size()
		if total > maxArchive {
			return errors.New("staged payload too large")
		}
		hash.Write([]byte(fmt.Sprintf("f:%d:%d\x00", stat.Size(), stat.Mode()&0111)))
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, err = io.Copy(hash, file)
		file.Close()
		return err
	})
	var result [32]byte
	copy(result[:], hash.Sum(nil))
	return result, err
}
