// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const (
	maxDesktopName = 48
	// pairRotateAfter is how often the desktop shows a fresh QR.
	pairRotateAfter = 90
	// firstCandidatesWait bounds how long pair.begin waits for the first
	// candidate snapshot after net.start.
	firstCandidatesWait = time.Second
	// diagnosticsTimeout bounds the fresh collection and the gateway probe
	// of diagnostics.run.
	diagnosticsTimeout = candidates.DefaultSTUNTimeout + time.Second
)

func (runtime *runtimeState) handleService(ctx context.Context, request rpc.Request) rpc.Response {
	var result any
	var err error
	switch request.Command {
	case "net.start":
		result, err = runtime.netStart(ctx, request.Args)
	case "net.stop":
		result, err = runtime.netStop(request.Args)
	case "net.status":
		result, err = runtime.netStatus(request.Args)
	case "net.refresh":
		result, err = runtime.netRefresh(ctx, request.Args)
	case "tor.status":
		if err = decodeArgs(request.Args, &struct{}{}); err != nil {
			err = invalid("Os argumentos do estado do Tor são inválidos.")
		} else {
			result = runtime.torStatus()
		}
	case "diagnostics.run":
		result, err = runtime.diagnosticsRun(ctx, request.Args)
	case "pair.begin":
		result, err = runtime.pairBegin(ctx, request.Args)
	case "pair.cancel":
		result, err = runtime.pairCancel(request.Args)
	case "pair.approve":
		result, err = runtime.pairDecision(request.Args, true)
	case "pair.deny":
		result, err = runtime.pairDecision(request.Args, false)
	case "devices.list":
		result, err = runtime.devicesList(request.Args)
	case "devices.revoke":
		result, err = runtime.deviceRevoke(request.Args)
	case "devices.rename":
		result, err = runtime.deviceRename(request.Args)
	case "devices.rotateToken":
		result, err = runtime.deviceRotate(request.Args)
	default:
		return failure(request.ID, "command_unknown", "O comando solicitado não existe neste sidecar.", false)
	}
	if err != nil {
		return runtime.errorResponse(request.ID, err)
	}
	return rpc.Success(request.ID, result)
}

type netStartArgs struct {
	DesktopName     string          `json:"desktopName"`
	RequireApproval bool            `json:"requireApproval"`
	STUN            json.RawMessage `json:"stun"`
	Tor             *bool           `json:"tor"`
	StaticDir       string          `json:"staticDir"`
	BridgeURL       string          `json:"bridgeUrl"`
	ProxySecret     string          `json:"proxySecret"`
}

// netStart brings the network up, or applies the name and the approval to the
// network already running. The static directory, the bridge URL and the proxy
// secret are injected by the native supervisor.
func (runtime *runtimeState) netStart(ctx context.Context, raw json.RawMessage) (any, error) {
	var args netStartArgs
	if err := decodeArgs(raw, &args); err != nil {
		return nil, invalid("Os argumentos para iniciar a rede são inválidos.")
	}
	if !validDesktopName(args.DesktopName) {
		return nil, invalid("O nome do computador precisa ter de 1 a 48 caracteres.")
	}
	if args.StaticDir == "" || args.BridgeURL == "" || args.ProxySecret == "" {
		return nil, invalid("A configuração da borda está incompleta.")
	}
	stun, err := runtime.stunServers(args.STUN)
	if err != nil {
		return nil, err
	}
	runtime.commandMu.Lock()
	defer runtime.commandMu.Unlock()
	if ctx.Err() != nil {
		return nil, &serviceError{code: "tunnel_stopping", message: "O núcleo do túnel está encerrando.", retryable: true}
	}
	if n := runtime.current(); n != nil {
		if err := runtime.openIdentity(args.DesktopName); err != nil {
			return nil, err
		}
		n.apply(args.DesktopName, args.RequireApproval)
		return runtime.status(), nil
	}
	if err := runtime.openIdentity(args.DesktopName); err != nil {
		runtime.setLastError(err)
		return nil, err
	}
	runtime.mu.Lock()
	config := startConfig{
		paths: runtime.paths, logger: runtime.logger, identity: runtime.identity, desktop: runtime.desktop,
		devices: runtime.devices, sessions: runtime.sessions, approver: runtime.approvals,
		requireApproval: args.RequireApproval, staticDir: args.StaticDir, bridgeURL: args.BridgeURL,
		proxySecret: args.ProxySecret, stunServers: stun, torEnabled: args.Tor == nil || *args.Tor,
		torExecutable: runtime.torExecutable, seams: runtime.seams,
		onEvent: runtime.emit, onChange: runtime.emitter.trigger, onTorState: runtime.emitTor,
	}
	runtime.mu.Unlock()
	n, err := startNetwork(config)
	if err != nil {
		runtime.setLastError(err)
		return nil, err
	}
	runtime.mu.Lock()
	runtime.net = n
	runtime.lastError = nil
	runtime.mu.Unlock()
	runtime.emitTor(n.status().Tor)
	runtime.emitter.trigger()
	return runtime.status(), nil
}

// stunServers reads the optional stun argument: absent or null keeps the
// default servers and a list, even empty, replaces them.
func (runtime *runtimeState) stunServers(raw json.RawMessage) ([]string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		if runtime.seams.STUNServers != nil {
			return append([]string(nil), runtime.seams.STUNServers...), nil
		}
		return append([]string(nil), DefaultSTUNServers...), nil
	}
	var servers []string
	if err := json.Unmarshal(raw, &servers); err != nil || servers == nil || len(servers) > 8 {
		return nil, invalid("A lista de servidores STUN precisa ser uma lista de host:porta.")
	}
	for _, server := range servers {
		if strings.TrimSpace(server) == "" || len(server) > 255 {
			return nil, invalid("A lista de servidores STUN precisa ser uma lista de host:porta.")
		}
	}
	return servers, nil
}

func (runtime *runtimeState) setLastError(err error) {
	var local *serviceError
	problem := &StatusError{Code: "internal", Message: "O núcleo do túnel não concluiu a operação."}
	if errors.As(err, &local) {
		problem = &StatusError{Code: local.code, Message: local.message}
	}
	runtime.mu.Lock()
	runtime.lastError = problem
	runtime.mu.Unlock()
	runtime.emitter.trigger()
}

func validDesktopName(name string) bool {
	if strings.TrimSpace(name) == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxDesktopName {
		return false
	}
	for _, character := range name {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func (runtime *runtimeState) netStop(raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos para parar a rede são inválidos.")
	}
	runtime.commandMu.Lock()
	defer runtime.commandMu.Unlock()
	runtime.stopNetwork()
	runtime.mu.Lock()
	runtime.lastError = nil
	runtime.mu.Unlock()
	runtime.emitter.trigger()
	return map[string]any{"state": netStopped}, nil
}

func (runtime *runtimeState) netStatus(raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos do estado da rede são inválidos.")
	}
	return runtime.status(), nil
}

func (runtime *runtimeState) netRefresh(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos para atualizar a rede são inválidos.")
	}
	if n := runtime.current(); n != nil {
		n.refresh(ctx)
	}
	return runtime.status(), nil
}

func (runtime *runtimeState) pairBegin(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		TTLSeconds *int `json:"ttlSeconds"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, invalid("Os argumentos do pareamento são inválidos.")
	}
	ttl := int(pairing.DefaultSessionTTL / time.Second)
	if args.TTLSeconds != nil {
		ttl = *args.TTLSeconds
	}
	if ttl < 1 || ttl > int(pairing.MaxSessionTTL/time.Second) {
		return nil, invalid("A validade do pareamento precisa ficar entre 1 e 600 segundos.")
	}
	n := runtime.current()
	if n == nil || n.direct == nil {
		return nil, &serviceError{code: "net_not_ready", message: "A rede deste computador ainda não está pronta para parear.", retryable: true}
	}
	snapshot := n.waitCandidates(ctx, firstCandidatesWait)
	active, err := runtime.sessions.Begin(pairing.Payload{
		Desktop: n.currentDesktop(), Onion: n.qrOnion(), Candidates: snapshot.ForQR(),
	}, time.Duration(ttl)*time.Second)
	if err != nil {
		return nil, err
	}
	runtime.emitter.trigger()
	return map[string]any{
		"pairId": active.PairID, "payload": active.Payload, "expiresAt": active.ExpiresAt.Unix(),
		"rotateAfterSeconds": pairRotateAfter, "reserve": n.status().Tor,
	}, nil
}

func (runtime *runtimeState) pairCancel(raw json.RawMessage) (any, error) {
	var args struct {
		PairID string `json:"pairId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.PairID == "" {
		return nil, invalid("Informe o pareamento que será cancelado.")
	}
	if err := runtime.sessions.Cancel(args.PairID); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (runtime *runtimeState) pairDecision(raw json.RawMessage, approved bool) (any, error) {
	var args struct {
		PairID string `json:"pairId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.PairID == "" {
		return nil, invalid("Informe o pareamento pendente.")
	}
	if !runtime.approvals.resolve(args.PairID, approved) {
		return nil, &serviceError{code: "pair_unknown", message: "Não existe aprovação pendente para este código."}
	}
	return map[string]any{}, nil
}

// DeviceView is a paired phone as devices.* return it: the registry record
// without token data, the key fingerprint and the live transports.
type DeviceView struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Model          string     `json:"model"`
	Platform       string     `json:"platform"`
	App            string     `json:"app"`
	DeviceKey      string     `json:"deviceKey"`
	Fingerprint    string     `json:"fingerprint"`
	PairedAt       time.Time  `json:"pairedAt"`
	LastSeenAt     time.Time  `json:"lastSeenAt"`
	LastTransport  string     `json:"lastTransport"`
	LastRemoteAddr string     `json:"lastRemoteAddr"`
	Revoked        bool       `json:"revoked"`
	RevokedAt      *time.Time `json:"revokedAt"`
	Connected      bool       `json:"connected"`
	Transports     []string   `json:"transports"`
}

func (runtime *runtimeState) deviceView(device pairing.Device) DeviceView {
	view := DeviceView{
		ID: device.ID, Name: device.Name, Model: device.Model, Platform: device.Platform, App: device.App,
		DeviceKey: device.DeviceKey, PairedAt: device.PairedAt, LastSeenAt: device.LastSeenAt,
		LastTransport: device.LastTransport, LastRemoteAddr: device.LastRemoteAddr,
		Revoked: device.Revoked, RevokedAt: device.RevokedAt, Transports: []string{},
	}
	if public, err := identity.ParsePublicKey(device.DeviceKey); err == nil {
		view.Fingerprint = identity.Fingerprint(public)
	}
	if n := runtime.current(); n != nil && !device.Revoked {
		view.Transports = n.transportsOf(device.DeviceKey)
		view.Connected = len(view.Transports) > 0
	}
	return view
}

func (runtime *runtimeState) devicesList(raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos da lista de dispositivos são inválidos.")
	}
	devices := runtime.registry()
	if devices == nil {
		return map[string]any{"devices": []DeviceView{}}, nil
	}
	if _, err := devices.PruneRevoked(); err != nil {
		runtime.logger.Warn("revoked devices not pruned", logx.Fields{"error": err.Error()})
	}
	list := devices.List()
	views := make([]DeviceView, 0, len(list))
	for _, device := range list {
		views = append(views, runtime.deviceView(device))
	}
	return map[string]any{"devices": views}, nil
}

func deviceNotFound() error {
	return &serviceError{code: "device_not_found", message: "O dispositivo não foi encontrado."}
}

// deviceRevoke revokes through edge.Server.Revoke, which emits devices.changed
// and closes the sessions on every transport. Without a running edge only the
// registry changes and the event is emitted here.
func (runtime *runtimeState) deviceRevoke(raw json.RawMessage) (any, error) {
	var args struct {
		DeviceID string `json:"deviceId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.DeviceID == "" {
		return nil, invalid("Informe o dispositivo que será revogado.")
	}
	runtime.commandMu.Lock()
	defer runtime.commandMu.Unlock()
	devices := runtime.registry()
	if devices == nil {
		return nil, deviceNotFound()
	}
	if _, found := devices.Get(args.DeviceID); !found {
		return nil, deviceNotFound()
	}
	if n := runtime.current(); n != nil && n.edge != nil {
		result, err := n.edge.Revoke(args.DeviceID)
		if err != nil {
			return nil, err
		}
		runtime.emitter.trigger()
		return map[string]any{"sessions": result.Sessions, "sockets": result.Sockets}, nil
	}
	if err := devices.Revoke(args.DeviceID); err != nil {
		return nil, err
	}
	runtime.emit("devices.changed", map[string]any{"deviceId": args.DeviceID, "revoked": true})
	return map[string]any{"sessions": 0, "sockets": 0}, nil
}

func (runtime *runtimeState) deviceRename(raw json.RawMessage) (any, error) {
	var args struct {
		DeviceID string `json:"deviceId"`
		Name     string `json:"name"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.DeviceID == "" || !validDesktopName(args.Name) {
		return nil, invalid("Informe o dispositivo e um nome de 1 a 48 caracteres.")
	}
	devices := runtime.registry()
	if devices == nil {
		return nil, deviceNotFound()
	}
	if _, found := devices.Get(args.DeviceID); !found {
		return nil, deviceNotFound()
	}
	if err := devices.Rename(args.DeviceID, args.Name); err != nil {
		return nil, err
	}
	device, _ := devices.Get(args.DeviceID)
	runtime.emit("devices.changed", map[string]any{"deviceId": args.DeviceID, "name": args.Name})
	return runtime.deviceView(device), nil
}

func (runtime *runtimeState) deviceRotate(raw json.RawMessage) (any, error) {
	var args struct {
		DeviceID string `json:"deviceId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.DeviceID == "" {
		return nil, invalid("Informe o dispositivo que terá o token girado.")
	}
	devices := runtime.registry()
	if devices == nil {
		return nil, deviceNotFound()
	}
	if err := devices.RequestTokenRotation(args.DeviceID); err != nil {
		return nil, deviceNotFound()
	}
	runtime.emit("devices.changed", map[string]any{"deviceId": args.DeviceID})
	return map[string]any{}, nil
}

func (runtime *runtimeState) errorResponse(id uint64, err error) rpc.Response {
	var local *serviceError
	if errors.As(err, &local) {
		if local.cause != nil {
			runtime.logger.Warn("sidecar command failed", logx.Fields{"code": local.code, "error": local.cause.Error()})
		}
		return failure(id, local.code, local.message, local.retryable)
	}
	if code := pairing.Code(err); code != "" {
		return failure(id, code, err.Error(), false)
	}
	runtime.logger.Error("sidecar command failed", logx.Fields{"error": err.Error()})
	return failure(id, "internal", "O núcleo do túnel não concluiu a operação.", false)
}
