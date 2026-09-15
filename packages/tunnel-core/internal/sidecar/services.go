// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/control"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
)

type serviceError struct {
	code      string
	message   string
	retryable bool
}

func (problem *serviceError) Error() string { return problem.message }

func invalid(message string) error {
	return &serviceError{code: "args_invalid", message: message}
}

func (runtime *runtimeState) handleService(ctx context.Context, request rpc.Request) rpc.Response {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	var result any
	var err error
	switch request.Command {
	case "control.configure":
		result, err = runtime.controlConfigure(ctx, request.Args)
	case "control.users.list":
		result, err = runtime.controlUsersList(ctx, request.Args)
	case "control.users.create":
		result, err = runtime.controlUsersCreate(ctx, request.Args)
	case "control.apikey.rotate":
		result, err = runtime.controlAPIKeyRotate(ctx, request.Args)
	case "control.apikey.expireOld":
		result, err = runtime.controlAPIKeyExpire(ctx, request.Args)
	case "node.up":
		result, err = runtime.nodeUp(ctx, request.Args)
	case "node.down":
		result, err = runtime.nodeDown(request.Args)
	case "node.status":
		result, err = runtime.nodeStatus(ctx, request.Args)
	case "node.logout":
		result, err = runtime.nodeLogout(ctx, request.Args)
	case "edge.serve":
		result, err = runtime.edgeServe(request.Args)
	case "edge.stop":
		result, err = runtime.edgeStop(request.Args)
	case "pair.begin":
		result, err = runtime.pairBegin(ctx, request.Args)
	case "pair.cancel":
		result, err = runtime.pairCancel(ctx, request.Args)
	case "pair.approve":
		result, err = runtime.pairDecision(request.Args, true)
	case "pair.deny":
		result, err = runtime.pairDecision(request.Args, false)
	case "devices.list":
		result, err = runtime.devicesList(request.Args)
	case "devices.revoke":
		result, err = runtime.deviceRevoke(ctx, request.Args)
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

func (runtime *runtimeState) controlConfigure(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		URL    string `json:"url"`
		APIKey string `json:"apiKey"`
		CAFile string `json:"caFile"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.URL == "" || args.APIKey == "" {
		return nil, invalid("Informe a URL e a chave da API do Headscale.")
	}
	admin, err := runtime.adminFactory(args.URL, args.APIKey, args.CAFile)
	if err != nil {
		return nil, err
	}
	health, err := admin.Health(ctx)
	if err != nil {
		return nil, err
	}
	if !health.OK {
		return nil, &serviceError{code: "control_protocol", message: "O servidor Headscale não está saudável."}
	}
	runtime.admin = admin
	runtime.controlURL = strings.TrimRight(args.URL, "/")
	runtime.caFile = args.CAFile
	prefix := safeAPIKeyPrefix(args.APIKey)
	apiKey := map[string]any{"prefix": prefix}
	if expiresAt, ok := runtime.apiKeyExpiry(ctx, admin, prefix); ok {
		apiKey["expiresAt"] = expiresAt.UTC().Format(time.RFC3339)
	}
	return map[string]any{"health": health, "apiKey": apiKey}, nil
}

type apiKeyLister interface {
	ListAPIKeys(context.Context) ([]control.APIKey, error)
}

// apiKeyExpiry is best effort: a server or broker that cannot list keys still
// configures, and the desktop falls back to showing the prefix.
func (runtime *runtimeState) apiKeyExpiry(ctx context.Context, admin control.ControlAdmin, prefix string) (time.Time, bool) {
	lister, ok := admin.(apiKeyLister)
	if !ok {
		return time.Time{}, false
	}
	keys, err := lister.ListAPIKeys(ctx)
	if err != nil {
		runtime.logger.Warn("could not read the API key expiration", map[string]any{"code": control.Code(err)})
		return time.Time{}, false
	}
	for _, key := range keys {
		if control.SameAPIKeyPrefix(key.Prefix, prefix) && !key.Expiration.IsZero() {
			return key.Expiration, true
		}
	}
	return time.Time{}, false
}

func (runtime *runtimeState) requireAdmin() (control.ControlAdmin, error) {
	if runtime.admin == nil {
		return nil, &serviceError{code: "control_unconfigured", message: "Configure o servidor Headscale primeiro."}
	}
	return runtime.admin, nil
}

func (runtime *runtimeState) controlUsersList(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos da lista de usuários são inválidos.")
	}
	admin, err := runtime.requireAdmin()
	if err != nil {
		return nil, err
	}
	users, err := admin.ListUsers(ctx)
	return map[string]any{"users": users}, err
}

func (runtime *runtimeState) controlUsersCreate(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.Name == "" {
		return nil, invalid("Informe um nome de usuário válido.")
	}
	admin, err := runtime.requireAdmin()
	if err != nil {
		return nil, err
	}
	user, err := admin.CreateUser(ctx, args.Name, args.DisplayName)
	return map[string]any{"user": user}, err
}

func (runtime *runtimeState) controlAPIKeyRotate(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Days int `json:"days"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.Days < 1 || args.Days > 3650 {
		return nil, invalid("A validade da chave precisa ficar entre 1 e 3650 dias.")
	}
	admin, err := runtime.requireAdmin()
	if err != nil {
		return nil, err
	}
	expiresAt := runtime.serverNow().Add(time.Duration(args.Days) * 24 * time.Hour).UTC()
	apiKey, err := admin.RotateAPIKey(ctx, expiresAt)
	if err != nil {
		return nil, err
	}
	replacement, err := runtime.adminFactory(runtime.controlURL, apiKey, runtime.caFile)
	if err != nil {
		return nil, err
	}
	runtime.admin = replacement
	return map[string]any{"apiKey": apiKey, "prefix": safeAPIKeyPrefix(apiKey), "expiresAt": expiresAt.Format(time.RFC3339)}, nil
}

func (runtime *runtimeState) controlAPIKeyExpire(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Prefix string `json:"prefix"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.Prefix == "" {
		return nil, invalid("Informe o prefixo da chave antiga.")
	}
	admin, err := runtime.requireAdmin()
	if err != nil {
		return nil, err
	}
	return map[string]any{}, admin.ExpireAPIKey(ctx, args.Prefix)
}

func safeAPIKeyPrefix(apiKey string) string {
	return control.APIKeyPrefix(apiKey)
}

func (runtime *runtimeState) serverNow() time.Time {
	if source, ok := runtime.admin.(interface{ ServerNow() time.Time }); ok {
		return source.ServerNow()
	}
	return time.Now()
}

func (runtime *runtimeState) nodeUp(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		ControlURL string `json:"controlUrl"`
		UserID     string `json:"userId"`
		UserName   string `json:"userName"`
		Hostname   string `json:"hostname"`
		AuthKey    string `json:"authKey"`
		ForceLogin bool   `json:"forceLogin"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.ControlURL == "" || args.UserID == "" || args.UserName == "" || args.Hostname == "" {
		return nil, invalid("A configuração do nó está incompleta.")
	}
	authKey := args.AuthKey
	var generatedKeyID uint64
	if authKey == "" {
		admin, err := runtime.requireAdmin()
		if err != nil {
			return nil, err
		}
		userID, err := strconv.ParseUint(args.UserID, 10, 64)
		if err != nil || userID == 0 {
			return nil, invalid("O usuário do nó é inválido.")
		}
		expiresAt := runtime.serverNow().Add(10 * time.Minute).UTC()
		key, err := admin.CreatePreAuthKey(ctx, userID, expiresAt)
		if err != nil {
			return nil, err
		}
		authKey = key.Key
		generatedKeyID = key.ID
		defer func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := admin.ExpirePreAuthKey(cleanupCtx, generatedKeyID); err != nil && control.Code(err) != "control_not_found" {
				runtime.logger.Warn("could not expire desktop enrollment key", map[string]any{"error": err.Error()})
			}
		}()
	}
	status, err := runtime.node.Up(ctx, node.Config{
		StateDir: runtime.paths.TSNet, ControlURL: args.ControlURL, UserID: args.UserID, UserName: args.UserName,
		Hostname: args.Hostname, AuthKey: authKey, ForceLogin: args.ForceLogin,
	})
	if err != nil {
		return nil, err
	}
	runtime.userID = args.UserID
	runtime.userName = args.UserName
	runtime.emit("node.state", status)
	return status, nil
}

func (runtime *runtimeState) nodeDown(raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos para encerrar o nó são inválidos.")
	}
	if err := runtime.node.Down(); err != nil {
		return nil, err
	}
	status := runtime.node.Snapshot()
	runtime.emit("node.state", status)
	return status, nil
}

func (runtime *runtimeState) nodeStatus(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos do estado do nó são inválidos.")
	}
	status, err := runtime.node.Status(ctx)
	if errors.Is(err, node.ErrStopped) {
		return runtime.node.Snapshot(), nil
	}
	return status, err
}

func (runtime *runtimeState) nodeLogout(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos para sair da rede são inválidos.")
	}
	if err := runtime.node.Logout(ctx); err != nil && !errors.Is(err, node.ErrStopped) {
		return nil, err
	}
	status := runtime.node.Snapshot()
	runtime.emit("node.state", status)
	return status, nil
}

type identityRecord struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	UserID     string    `json:"userId"`
	UserName   string    `json:"userName"`
	ControlURL string    `json:"controlUrl"`
	CreatedAt  time.Time `json:"createdAt"`
}

func (runtime *runtimeState) edgeServe(raw json.RawMessage) (any, error) {
	var args struct {
		Port            int    `json:"port"`
		StaticDir       string `json:"staticDir"`
		BridgeURL       string `json:"bridgeUrl"`
		ProxySecret     string `json:"proxySecret"`
		RequireApproval bool   `json:"requireApproval"`
		CSP             string `json:"csp"`
		Desktop         struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"desktop"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.StaticDir == "" || args.BridgeURL == "" || args.ProxySecret == "" || args.Desktop.ID == "" || args.Desktop.Name == "" {
		return nil, invalid("A configuração da borda está incompleta.")
	}
	if runtime.edge != nil {
		return nil, &serviceError{code: "edge_running", message: "A borda já está aberta."}
	}
	status := runtime.node.Snapshot()
	if status.State != node.Running || status.NodeKey == "" || status.IP4 == "" {
		return nil, &serviceError{code: "node_offline", message: "O nó precisa estar conectado antes de abrir a borda.", retryable: true}
	}
	desktop := pairing.DesktopIdentity{ID: args.Desktop.ID, Name: args.Desktop.Name, CreatedAt: time.Now().UTC()}
	devices, err := pairing.OpenRegistry(runtime.paths, desktop, nil, nil)
	if err != nil {
		return nil, err
	}
	port := args.Port
	if port == 0 {
		port = edge.DefaultPort
	}
	server, err := edge.New(edge.Config{
		StaticDir: args.StaticDir, BridgeURL: args.BridgeURL, ProxySecret: args.ProxySecret,
		Desktop: desktop, Port: port, CSP: args.CSP, Sessions: runtime.sessions, Devices: devices,
		WhoIs: runtime.node, KeyExpirer: runtime.admin, RequireApproval: args.RequireApproval, Approver: runtime.approvals, OnEvent: runtime.emit,
	})
	if err != nil {
		return nil, err
	}
	listener, err := runtime.node.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return nil, err
	}
	record, _ := json.MarshalIndent(identityRecord{ID: desktop.ID, Name: desktop.Name, UserID: runtime.userID, UserName: runtime.userName, ControlURL: runtime.controlURL, CreatedAt: desktop.CreatedAt}, "", "  ")
	if err := runtime.paths.WriteAtomic(runtime.paths.Identity, append(record, '\n')); err != nil {
		_ = listener.Close()
		return nil, err
	}
	runtime.desktop = desktop
	runtime.devices = devices
	runtime.edge = server
	runtime.edgeListener = listener
	runtime.edgePort = port
	go func() {
		runtime.emit("edge.state", map[string]any{"state": "running", "port": port})
		if err := server.Serve(listener); err != nil {
			runtime.logger.Error("edge server stopped", map[string]any{"error": err.Error()})
			runtime.emit("edge.state", map[string]any{"state": "failed"})
		}
	}()
	return map[string]any{"port": port}, nil
}

func (runtime *runtimeState) edgeStop(raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos para fechar a borda são inválidos.")
	}
	server := runtime.edge
	listener := runtime.edgeListener
	runtime.edge = nil
	runtime.edgeListener = nil
	runtime.edgePort = 0
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			return nil, err
		}
	}
	if listener != nil {
		_ = listener.Close()
	}
	runtime.emit("edge.state", map[string]any{"state": "stopped"})
	return map[string]any{}, nil
}

func (runtime *runtimeState) pairBegin(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		TTLSeconds int `json:"ttlSeconds"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.TTLSeconds < 1 || args.TTLSeconds > 600 {
		return nil, invalid("A validade do pareamento precisa ficar entre 1 e 600 segundos.")
	}
	admin, err := runtime.requireAdmin()
	if err != nil {
		return nil, err
	}
	if runtime.devices == nil || runtime.edge == nil || runtime.desktop.ID == "" {
		return nil, &serviceError{code: "edge_stopped", message: "Abra a borda antes de gerar o pareamento."}
	}
	userID, err := strconv.ParseUint(runtime.userID, 10, 64)
	if err != nil || userID == 0 {
		return nil, &serviceError{code: "node_identity", message: "O nó não tem um usuário válido."}
	}
	status := runtime.node.Snapshot()
	if status.State != node.Running || status.NodeKey == "" || status.IP4 == "" {
		return nil, &serviceError{code: "node_offline", message: "O computador não está acessível na rede.", retryable: true}
	}
	expiresAt := runtime.serverNow().Add(time.Duration(args.TTLSeconds) * time.Second).UTC()
	key, err := admin.CreatePreAuthKey(ctx, userID, expiresAt)
	if err != nil {
		return nil, err
	}
	template := pairing.Payload{
		ControlURL: runtime.controlURL, UserID: runtime.userID, UserName: runtime.userName, AuthKey: &key.Key,
		Desktop: pairing.Desktop{ID: runtime.desktop.ID, Name: runtime.desktop.Name, NodeKey: status.NodeKey, IP4: status.IP4, Port: runtime.edgePort},
	}
	active, err := runtime.sessions.Begin(template, key.ID, time.Duration(args.TTLSeconds)*time.Second)
	if err != nil {
		_ = admin.ExpirePreAuthKey(ctx, key.ID)
		return nil, err
	}
	return active, nil
}

func (runtime *runtimeState) pairCancel(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		PairID string `json:"pairId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.PairID == "" {
		return nil, invalid("Informe o pareamento que será cancelado.")
	}
	keyID, err := runtime.sessions.Cancel(args.PairID)
	if err != nil {
		return nil, err
	}
	if runtime.admin != nil {
		if err := runtime.admin.ExpirePreAuthKey(ctx, keyID); err != nil && control.Code(err) != "control_not_found" {
			return nil, err
		}
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

type deviceView struct {
	pairing.Device
	Online bool `json:"online"`
}

func (runtime *runtimeState) devicesList(raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos da lista de dispositivos são inválidos.")
	}
	if runtime.devices == nil {
		return map[string]any{"devices": []deviceView{}}, nil
	}
	_, _ = runtime.devices.PruneRevoked()
	devices := runtime.devices.List()
	result := make([]deviceView, len(devices))
	for index, device := range devices {
		peer, found := runtime.node.Peer(device.NodeKey)
		result[index] = deviceView{Device: device, Online: found && peer.Online && !device.Revoked}
	}
	return map[string]any{"devices": result}, nil
}

func (runtime *runtimeState) deviceRevoke(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		DeviceID string `json:"deviceId"`
		Network  bool   `json:"network"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.DeviceID == "" {
		return nil, invalid("Informe o dispositivo que será revogado.")
	}
	if runtime.devices == nil {
		return nil, &serviceError{code: "device_not_found", message: "O dispositivo não foi encontrado."}
	}
	device, found := runtime.devices.Get(args.DeviceID)
	if !found {
		return nil, &serviceError{code: "device_not_found", message: "O dispositivo não foi encontrado."}
	}
	if err := runtime.devices.Revoke(args.DeviceID); err != nil {
		return nil, err
	}
	if runtime.edge != nil {
		runtime.edge.RevokeConnections(args.DeviceID)
	}
	runtime.emit("devices.changed", map[string]any{"deviceId": args.DeviceID, "revoked": true})
	if args.Network {
		admin, err := runtime.requireAdmin()
		if err != nil {
			return nil, err
		}
		nodeID, err := strconv.ParseUint(device.NodeID, 10, 64)
		if err != nil {
			return nil, errors.New("device has an invalid node id")
		}
		firstErr := admin.ExpireNode(ctx, nodeID)
		deleteErr := admin.DeleteNode(ctx, nodeID)
		if firstErr != nil {
			return nil, firstErr
		}
		if deleteErr != nil {
			return nil, deleteErr
		}
	}
	return map[string]any{}, nil
}

func (runtime *runtimeState) deviceRename(raw json.RawMessage) (any, error) {
	var args struct {
		DeviceID string `json:"deviceId"`
		Name     string `json:"name"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.DeviceID == "" || args.Name == "" {
		return nil, invalid("Informe o dispositivo e o novo nome.")
	}
	if runtime.devices == nil {
		return nil, &serviceError{code: "device_not_found", message: "O dispositivo não foi encontrado."}
	}
	if err := runtime.devices.Rename(args.DeviceID, args.Name); err != nil {
		return nil, err
	}
	runtime.emit("devices.changed", map[string]any{"deviceId": args.DeviceID, "name": args.Name})
	return map[string]any{}, nil
}

func (runtime *runtimeState) deviceRotate(raw json.RawMessage) (any, error) {
	var args struct {
		DeviceID string `json:"deviceId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.DeviceID == "" {
		return nil, invalid("Informe o dispositivo que terá o token girado.")
	}
	if runtime.devices == nil {
		return nil, &serviceError{code: "device_not_found", message: "O dispositivo não foi encontrado."}
	}
	if err := runtime.devices.RequestTokenRotation(args.DeviceID); err != nil {
		return nil, err
	}
	runtime.emit("devices.changed", map[string]any{"deviceId": args.DeviceID})
	return map[string]any{}, nil
}

func (runtime *runtimeState) emit(name string, data any) {
	event, err := rpc.NewEvent(name, data, time.Now())
	if err == nil {
		_ = runtime.writer.Write(event)
	}
}

func (runtime *runtimeState) errorResponse(id uint64, err error) rpc.Response {
	var controlError *control.Error
	if errors.As(err, &controlError) {
		return failure(id, controlError.Code, controlError.Message, controlError.Retryable)
	}
	if code := pairing.Code(err); code != "" {
		return failure(id, code, err.Error(), false)
	}
	var local *serviceError
	if errors.As(err, &local) {
		return failure(id, local.code, local.message, local.retryable)
	}
	runtime.logger.Error("sidecar command failed", map[string]any{"error": err.Error()})
	return failure(id, "internal", "O núcleo do túnel não concluiu a operação.", false)
}

var _ edge.IdentityResolver = (*node.Manager)(nil)
