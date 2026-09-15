// SPDX-License-Identifier: Apache-2.0
// Package mobile is the gomobile boundary used by the iOS and Android shells.
// Structured values cross the native boundary as JSON and device tokens are
// never persisted by this package.
package mobile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

const (
	version             = "0.1.0"
	mobileStateFile     = "mobile-state.json"
	maxMobileStateBytes = 1 << 20
)

// Listener receives non-secret lifecycle events. kind is one of state, peer,
// proxy, pair or log and payloadJSON is always a JSON object.
type Listener interface {
	OnEvent(kind string, payloadJSON string)
}

type storedDesktop struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Port    int    `json:"port"`
	NodeKey string `json:"nodeKey"`
}

type storedProfile struct {
	ID         string                   `json:"id"`
	ControlURL string                   `json:"controlUrl"`
	UserID     string                   `json:"userId"`
	UserName   string                   `json:"userName"`
	Hostname   string                   `json:"hostname"`
	Desktops   map[string]storedDesktop `json:"desktops"`
}

type stateFile struct {
	Version  int             `json:"version"`
	Profiles []storedProfile `json:"profiles"`
}

// Tunnel owns one tsnet node and at most one loopback proxy. Calls which change
// the active profile are serialized because tsnet state directories have a
// single owner.
type Tunnel struct {
	opMu          sync.Mutex
	mu            sync.RWMutex
	paths         statedir.Paths
	listener      Listener
	node          *node.Manager
	profiles      map[string]storedProfile
	activeProfile string
	openDesktop   string
	proxy         *proxy.Proxy
	logLevel      string
}

// Version identifies the Go mobile API and is safe to call before NewTunnel.
func Version() string { return version }

// NewTunnel opens private mobile state. stateDir must be an absolute app data
// directory which the native module has already excluded from backups.
func NewTunnel(stateDir string, listener Listener) (*Tunnel, error) {
	paths, err := statedir.Prepare(stateDir)
	if err != nil {
		return nil, coded("state_invalid", err)
	}
	tunnel := &Tunnel{
		paths: paths, listener: listener,
		node:     node.NewTSNetManager(func(string, ...any) {}, func(string, ...any) {}),
		profiles: map[string]storedProfile{}, logLevel: "info",
	}
	if err := tunnel.load(); err != nil {
		return nil, err
	}
	return tunnel, nil
}

// InspectPairPayload validates the strict QR schema without returning the
// enrollment key or pairing secret.
func (tunnel *Tunnel) InspectPairPayload(payload string) (string, error) {
	inspection, err := pairing.Inspect(payload, time.Now(), false)
	if err != nil {
		return "", pairingProblem(err)
	}
	tunnel.mu.RLock()
	for _, profile := range tunnel.profiles {
		if profile.ControlURL == inspection.Control && profile.UserID == inspection.UserID {
			inspection.ProfileMatch = "existing"
			break
		}
	}
	tunnel.mu.RUnlock()
	if inspection.ProfileMatch == "" {
		inspection.ProfileMatch = "new"
	}
	return marshalJSON(inspection)
}

// Pair joins the matching profile, reaches the desktop through tsnet and
// exchanges the one-use QR proof for a per-device token returned to native.
func (tunnel *Tunnel) Pair(payloadText, deviceName, deviceModel, platform, appVersion string) (string, error) {
	if err := validateDevice(deviceName, deviceModel, platform, appVersion); err != nil {
		return "", err
	}
	payload, err := pairing.Decode(payloadText, false)
	if err != nil {
		return "", pairingProblem(err)
	}
	if payload.ExpiresAt < time.Now().Add(-time.Minute).Unix() {
		return "", codedMessage("payload_expired", "Este código expirou. Gere um novo no computador.")
	}

	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	profile, exists := tunnel.profileFor(payload.ControlURL, payload.UserID)
	if !exists {
		profile = storedProfile{
			ID: profileID(payload.ControlURL, payload.UserID), ControlURL: payload.ControlURL,
			UserID: payload.UserID, UserName: payload.UserName,
			Hostname: deviceHostname(deviceModel, profileID(payload.ControlURL, payload.UserID)),
			Desktops: map[string]storedDesktop{},
		}
	}
	if tunnel.activeProfile != profile.ID {
		if err := tunnel.stopLocked(); err != nil {
			return "", err
		}
		authKey := ""
		if !exists && payload.AuthKey != nil {
			authKey = *payload.AuthKey
		}
		if err := tunnel.startLocked(profile, authKey); err != nil {
			return "", err
		}
	}
	status, err := tunnel.waitForPeer(payload.Desktop.NodeKey, 20*time.Second)
	if err != nil {
		return "", err
	}
	result, err := tunnel.exchangePair(payload, status.NodeKey, deviceName, deviceModel, platform, appVersion)
	if err != nil {
		return "", err
	}
	profile.Desktops[payload.Desktop.ID] = storedDesktop{
		ID: payload.Desktop.ID, Name: result.Desktop.Name, Port: result.Desktop.Port, NodeKey: payload.Desktop.NodeKey,
	}
	tunnel.mu.Lock()
	tunnel.profiles[profile.ID] = profile
	tunnel.mu.Unlock()
	if err := tunnel.save(); err != nil {
		return "", err
	}
	output := map[string]any{
		"profileId": profile.ID, "desktopId": payload.Desktop.ID, "deviceId": result.DeviceID,
		"token": result.Token, "desktop": map[string]any{
			"id": payload.Desktop.ID, "name": result.Desktop.Name, "port": result.Desktop.Port, "nodeKey": payload.Desktop.NodeKey,
		}, "nodeKey": status.NodeKey,
	}
	tunnel.emit("pair", map[string]any{"state": "completed", "profileId": profile.ID, "desktopId": payload.Desktop.ID})
	return marshalJSON(output)
}

// StartProfile activates an enrolled profile without accepting credentials.
func (tunnel *Tunnel) StartProfile(profileID string) error {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	profile, ok := tunnel.profile(profileID)
	if !ok {
		return codedMessage("profile_unknown", "O perfil solicitado não existe neste aparelho.")
	}
	if tunnel.activeProfile == profileID {
		return nil
	}
	if err := tunnel.stopLocked(); err != nil {
		return err
	}
	return tunnel.startLocked(profile, "")
}

// Stop closes the loopback proxy before stopping the active node.
func (tunnel *Tunnel) Stop() error {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	return tunnel.stopLocked()
}

// StatusJSON returns the last known status even while the node is stopped.
func (tunnel *Tunnel) StatusJSON() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	status, err := tunnel.node.Status(ctx)
	if err != nil && !errors.Is(err, node.ErrStopped) {
		return "", coded("status_failed", err)
	}
	if errors.Is(err, node.ErrStopped) {
		status = tunnel.node.Snapshot()
	}
	return marshalJSON(status)
}

// OpenDesktop creates the authenticated loopback origin consumed by WebView.
func (tunnel *Tunnel) OpenDesktop(desktopID, deviceToken string, preferredPort int) (string, error) {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	profile, ok := tunnel.profile(tunnel.activeProfile)
	if !ok {
		return "", codedMessage("profile_inactive", "Inicie o perfil antes de abrir o computador.")
	}
	desktop, ok := profile.Desktops[desktopID]
	if !ok {
		return "", codedMessage("desktop_unknown", "O computador solicitado não pertence ao perfil ativo.")
	}
	if err := tunnel.closeProxyLocked(); err != nil {
		return "", err
	}
	instance, err := proxy.New(proxy.Config{
		Tunnel: tunnel.node, DesktopID: desktop.ID, DesktopNodeKey: desktop.NodeKey,
		DesktopPort: desktop.Port, DeviceToken: deviceToken,
		OnToken: func(next string) error {
			tunnel.emit("proxy", map[string]any{"state": "token-rotated", "desktopId": desktop.ID, "deviceToken": next})
			return nil
		},
	})
	if err != nil {
		return "", coded("proxy_invalid", err)
	}
	opened, err := instance.Open(preferredPort)
	if err != nil {
		return "", coded("proxy_open_failed", err)
	}
	tunnel.mu.Lock()
	tunnel.proxy = instance
	tunnel.openDesktop = desktop.ID
	tunnel.mu.Unlock()
	tunnel.emit("proxy", map[string]any{"state": "open", "desktopId": desktop.ID, "port": opened.Port, "warning": opened.Warning})
	return marshalJSON(opened)
}

// CloseDesktop closes the proxy only when it belongs to desktopID.
func (tunnel *Tunnel) CloseDesktop(desktopID string) error {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	tunnel.mu.RLock()
	openID := tunnel.openDesktop
	tunnel.mu.RUnlock()
	if openID != "" && openID != desktopID {
		return codedMessage("desktop_not_open", "Este computador não está aberto no proxy local.")
	}
	return tunnel.closeProxyLocked()
}

// NotifyNetworkChange asks tsnet to rebind and discover a fresh path.
func (tunnel *Tunnel) NotifyNetworkChange(reachable bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := tunnel.node.NotifyNetworkChange(ctx, reachable); err != nil && !errors.Is(err, node.ErrStopped) {
		tunnel.emit("log", map[string]any{"level": "error", "code": "network_change_failed"})
		return
	}
	tunnel.emit("state", map[string]any{"reachable": reachable})
}

// NotifyForeground refreshes paths on resume. Native code owns the platform
// background deadline and may call Stop before a later StartProfile.
func (tunnel *Tunnel) NotifyForeground(active bool) {
	if active {
		tunnel.NotifyNetworkChange(true)
		return
	}
	tunnel.emit("state", map[string]any{"foreground": false})
}

// ForgetProfile logs out the active profile, removes its tsnet state and drops
// only non-secret mobile metadata for that profile.
func (tunnel *Tunnel) ForgetProfile(profileID string) error {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	if _, ok := tunnel.profile(profileID); !ok {
		return nil
	}
	if tunnel.activeProfile == profileID {
		if err := tunnel.stopLocked(); err != nil {
			return err
		}
	}
	target := tunnel.profileStateDir(profileID)
	if !pathInside(tunnel.paths.Root, target) {
		return codedMessage("state_invalid", "O diretório do perfil não é seguro.")
	}
	if err := os.RemoveAll(target); err != nil {
		return coded("profile_forget_failed", err)
	}
	tunnel.mu.Lock()
	delete(tunnel.profiles, profileID)
	tunnel.mu.Unlock()
	return tunnel.save()
}

// SetLogLevel selects which sanitized native events may be emitted.
func (tunnel *Tunnel) SetLogLevel(level string) {
	if level != "error" && level != "info" && level != "debug" {
		return
	}
	tunnel.mu.Lock()
	tunnel.logLevel = level
	tunnel.mu.Unlock()
}

type pairResponse struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	Desktop  struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Port int    `json:"port"`
	} `json:"desktop"`
}

func (tunnel *Tunnel) exchangePair(payload pairing.Payload, nodeKey, name, model, platform, appVersion string) (pairResponse, error) {
	body, err := json.Marshal(map[string]any{
		"v": 1, "pairId": payload.PairID, "secret": payload.Secret,
		"device": map[string]string{"name": name, "model": model, "platform": platform, "app": appVersion, "nodeKey": nodeKey},
	})
	if err != nil {
		return pairResponse{}, coded("pair_internal", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		peer, ok := tunnel.node.Peer(payload.Desktop.NodeKey)
		if !ok {
			return nil, errors.New("desktop peer disappeared")
		}
		host := peer.IP4
		if host == "" {
			host = peer.IP6
		}
		return tunnel.node.Dial(ctx, network, net.JoinHostPort(host, fmt.Sprint(payload.Desktop.Port)))
	}}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://cialai-desktop/pair", bytes.NewReader(body))
	if err != nil {
		return pairResponse{}, coded("pair_internal", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return pairResponse{}, codedMessage("peer_not_found", "Seu computador ainda não está acessível. Deixe o Cialai aberto nele e tente de novo.")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxMobileStateBytes+1))
	if err != nil || len(raw) > maxMobileStateBytes {
		return pairResponse{}, codedMessage("pair_invalid_response", "O computador devolveu uma resposta de pareamento inválida.")
	}
	if response.StatusCode != http.StatusOK {
		var problem struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &problem) == nil && problem.Error.Code != "" {
			return pairResponse{}, codedMessage(problem.Error.Code, problem.Error.Message)
		}
		return pairResponse{}, codedMessage("pair_failed", "O computador recusou o pareamento.")
	}
	var result pairResponse
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil || result.DeviceID == "" || result.Token == "" || result.Desktop.ID != payload.Desktop.ID || result.Desktop.Name == "" || result.Desktop.Port < 1 || result.Desktop.Port > 65535 {
		return pairResponse{}, codedMessage("pair_invalid_response", "O computador devolveu uma resposta de pareamento inválida.")
	}
	return result, nil
}

func (tunnel *Tunnel) startLocked(profile storedProfile, authKey string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	status, err := tunnel.node.Up(ctx, node.Config{
		StateDir: tunnel.profileStateDir(profile.ID), ControlURL: profile.ControlURL,
		UserID: profile.UserID, UserName: profile.UserName, Hostname: profile.Hostname, AuthKey: authKey,
	})
	if err != nil {
		code := "profile_start_failed"
		if authKey != "" {
			code = "auth_key_rejected"
		}
		return coded(code, err)
	}
	tunnel.mu.Lock()
	tunnel.activeProfile = profile.ID
	tunnel.mu.Unlock()
	tunnel.emit("state", status)
	return nil
}

func (tunnel *Tunnel) stopLocked() error {
	if err := tunnel.closeProxyLocked(); err != nil {
		return err
	}
	if err := tunnel.node.Down(); err != nil {
		return coded("profile_stop_failed", err)
	}
	tunnel.mu.Lock()
	tunnel.activeProfile = ""
	tunnel.mu.Unlock()
	tunnel.emit("state", map[string]any{"state": "stopped"})
	return nil
}

func (tunnel *Tunnel) closeProxyLocked() error {
	tunnel.mu.Lock()
	instance := tunnel.proxy
	desktopID := tunnel.openDesktop
	tunnel.proxy = nil
	tunnel.openDesktop = ""
	tunnel.mu.Unlock()
	if instance == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := instance.Close(ctx); err != nil {
		return coded("proxy_close_failed", err)
	}
	tunnel.emit("proxy", map[string]any{"state": "closed", "desktopId": desktopID})
	return nil
}

func (tunnel *Tunnel) waitForPeer(nodeKey string, timeout time.Duration) (node.Status, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		status, err := tunnel.node.Status(ctx)
		if err == nil {
			if peer, found := tunnel.node.Peer(nodeKey); found && (peer.IP4 != "" || peer.IP6 != "") {
				tunnel.emit("peer", peer)
				return status, nil
			}
		}
		select {
		case <-ctx.Done():
			return node.Status{}, codedMessage("peer_not_found", "Seu computador ainda não está acessível. Deixe o Cialai aberto nele e tente de novo.")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (tunnel *Tunnel) load() error {
	raw, err := os.ReadFile(filepath.Join(tunnel.paths.Root, mobileStateFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return coded("state_read_failed", err)
	}
	if len(raw) > maxMobileStateBytes {
		return codedMessage("state_invalid", "O estado móvel excede o tamanho permitido.")
	}
	var stored stateFile
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil || stored.Version != 1 {
		return codedMessage("state_invalid", "O estado móvel está corrompido.")
	}
	for _, profile := range stored.Profiles {
		if profile.ID == "" || profile.ControlURL == "" || profile.UserID == "" || profile.Hostname == "" || profile.Desktops == nil {
			return codedMessage("state_invalid", "O estado móvel contém um perfil inválido.")
		}
		tunnel.profiles[profile.ID] = profile
	}
	return nil
}

func (tunnel *Tunnel) save() error {
	tunnel.mu.RLock()
	stored := stateFile{Version: 1, Profiles: make([]storedProfile, 0, len(tunnel.profiles))}
	for _, profile := range tunnel.profiles {
		stored.Profiles = append(stored.Profiles, profile)
	}
	tunnel.mu.RUnlock()
	raw, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return coded("state_write_failed", err)
	}
	if err := tunnel.paths.WriteAtomic(filepath.Join(tunnel.paths.Root, mobileStateFile), append(raw, '\n')); err != nil {
		return coded("state_write_failed", err)
	}
	return nil
}

func (tunnel *Tunnel) profile(profileID string) (storedProfile, bool) {
	tunnel.mu.RLock()
	defer tunnel.mu.RUnlock()
	profile, ok := tunnel.profiles[profileID]
	return profile, ok
}

func (tunnel *Tunnel) profileFor(controlURL, userID string) (storedProfile, bool) {
	tunnel.mu.RLock()
	defer tunnel.mu.RUnlock()
	for _, profile := range tunnel.profiles {
		if profile.ControlURL == controlURL && profile.UserID == userID {
			return profile, true
		}
	}
	return storedProfile{}, false
}

func (tunnel *Tunnel) profileStateDir(profileID string) string {
	return filepath.Join(tunnel.paths.Root, "profiles", profileID, "tsnet")
}

func (tunnel *Tunnel) emit(kind string, payload any) {
	if tunnel.listener == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err == nil {
		tunnel.listener.OnEvent(kind, string(raw))
	}
}

func validateDevice(name, model, platform, appVersion string) error {
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 48 || strings.TrimSpace(model) == "" || len([]rune(model)) > 64 || strings.TrimSpace(appVersion) == "" || len([]rune(appVersion)) > 32 {
		return codedMessage("device_invalid", "A identificação deste aparelho é inválida.")
	}
	if platform != "ios" && platform != "android" {
		return codedMessage("device_invalid", "A plataforma deste aparelho é inválida.")
	}
	return nil
}

func profileID(controlURL, userID string) string {
	digest := sha256.Sum256([]byte(controlURL + "\x00" + userID))
	return "profile_" + base64.RawURLEncoding.EncodeToString(digest[:16])
}

func deviceHostname(model, suffix string) string {
	clean := strings.ToLower(model)
	clean = strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			return character
		}
		return '-'
	}, clean)
	clean = strings.Trim(strings.Join(strings.FieldsFunc(clean, func(character rune) bool { return character == '-' }), "-"), "-")
	if clean == "" {
		clean = "mobile"
	}
	tail := suffix
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return "cialai-" + clean + "-" + strings.ToLower(tail)
}

func pathInside(root, target string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func marshalJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", coded("json_failed", err)
	}
	return string(raw), nil
}

func pairingProblem(err error) error {
	if code := pairing.Code(err); code != "" {
		return codedMessage(code, err.Error())
	}
	return coded("payload_invalid", err)
}

func coded(code string, err error) error {
	return fmt.Errorf("%s: %w", code, err)
}

func codedMessage(code, message string) error {
	return errors.New(code + ": " + message)
}
