// SPDX-License-Identifier: Apache-2.0
// Package edgev1 keeps the Headscale-era edge: it serves the mobile site and
// authenticates tailnet requests with WhoIs before forwarding WebSocket
// upgrades to the desktop bridge on loopback. The sidecar uses it until the RPC
// v2 migration (CON-029) and the Headscale mode is removed in phase 6
// (decision CON-D12). New code uses the parent edge package.
package edgev1

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
)

const (
	DefaultPort       = 4740
	MaxPairBodyBytes  = 16 * 1024
	MaxPairingsPerMin = 5
	MaxDeviceSockets  = 2
	MaxBridgeSockets  = 8
	defaultCSP        = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'self' blob:"
)

type IdentityResolver interface {
	WhoIs(context.Context, string) (node.Identity, error)
}

type KeyExpirer interface {
	ExpirePreAuthKey(context.Context, uint64) error
}

type ApprovalRequest struct {
	PairID string        `json:"pairId"`
	Device PairDevice    `json:"device"`
	Peer   node.Identity `json:"peer"`
	Until  time.Time     `json:"until"`
}

type Approver interface {
	Await(context.Context, ApprovalRequest) error
}

type EventSink func(name string, data any)

type Config struct {
	StaticDir       string
	BridgeURL       string
	ProxySecret     string
	Desktop         pairing.DesktopIdentity
	Port            int
	CSP             string
	Sessions        *pairing.Sessions
	Devices         *pairing.Registry
	WhoIs           IdentityResolver
	KeyExpirer      KeyExpirer
	RequireApproval bool
	Approver        Approver
	OnEvent         EventSink
	Now             func() time.Time
}

type rateWindow struct {
	started time.Time
	count   int
}

type connectionContextKey struct{}

type Server struct {
	config     Config
	staticRoot string
	bridge     *url.URL
	proxy      *httputil.ReverseProxy
	rateMu     sync.Mutex
	rates      map[string]rateWindow
	activeMu   sync.Mutex
	active     map[string]map[net.Conn]struct{}
	activeAnon map[string]int
	total      int
	httpMu     sync.Mutex
	httpServer *http.Server
}

func New(config Config) (*Server, error) {
	root, err := filepath.EvalSymlinks(config.StaticDir)
	if err != nil {
		return nil, fmt.Errorf("resolve static directory: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, errors.New("static directory is required")
	}
	bridge, err := parseBridgeURL(config.BridgeURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ProxySecret) == "" || config.Sessions == nil || config.Devices == nil || config.WhoIs == nil || config.Desktop.ID == "" || config.Desktop.Name == "" {
		return nil, errors.New("edge dependencies and desktop identity are required")
	}
	if config.Port == 0 {
		config.Port = DefaultPort
	}
	if config.Port < 1 || config.Port > 65535 {
		return nil, errors.New("edge port is invalid")
	}
	if config.CSP == "" {
		config.CSP = defaultCSP
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	server := &Server{
		config: config, staticRoot: root, bridge: bridge, rates: make(map[string]rateWindow),
		active: make(map[string]map[net.Conn]struct{}), activeAnon: make(map[string]int),
	}
	server.proxy = server.newBridgeProxy()
	return server, nil
}

func parseBridgeURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("bridge URL must be HTTP on loopback")
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("bridge URL must be HTTP on loopback")
	}
	return parsed, nil
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.securityHeaders(response)
	switch request.URL.Path {
	case "/api/health":
		server.serveHealth(response, request)
	case "/pair":
		server.servePair(response, request)
	case "/pty":
		server.serveUpgrade(response, request)
	case "/":
		if isUpgrade(request) {
			server.serveUpgrade(response, request)
			return
		}
		server.serveStatic(response, request)
	default:
		if strings.HasPrefix(request.URL.Path, "/api/") {
			http.NotFound(response, request)
			return
		}
		server.serveStatic(response, request)
	}
}

func (server *Server) securityHeaders(response http.ResponseWriter) {
	response.Header().Set("Content-Security-Policy", server.config.CSP)
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Referrer-Policy", "no-referrer")
}

func (server *Server) serveHealth(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusOK)
	if request.Method == http.MethodGet {
		_ = json.NewEncoder(response).Encode(map[string]any{
			"status": "ok", "service": "cialai",
			"desktop": map[string]string{"id": server.config.Desktop.ID, "name": server.config.Desktop.Name},
		})
	}
}

func (server *Server) serveStatic(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	clean, ok := safeRequestPath(request)
	if !ok {
		http.NotFound(response, request)
		return
	}
	isAsset := strings.HasPrefix(clean, "assets/")
	target := filepath.Join(server.staticRoot, filepath.FromSlash(clean))
	if clean == "" {
		target = filepath.Join(server.staticRoot, "mobile.html")
	}
	resolved, info, ok := server.resolveStatic(target)
	if !ok {
		if isAsset {
			http.NotFound(response, request)
			return
		}
		resolved, info, ok = server.resolveStatic(filepath.Join(server.staticRoot, "mobile.html"))
		if !ok {
			http.NotFound(response, request)
			return
		}
	}
	file, err := os.Open(resolved)
	if err != nil {
		http.NotFound(response, request)
		return
	}
	defer file.Close()
	if isAsset {
		response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		response.Header().Set("Cache-Control", "no-store")
	}
	if contentType := staticContentType(resolved); contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	http.ServeContent(response, request, info.Name(), info.ModTime(), file)
}

// staticTypes pins the types of the mobile site files. On Windows the mime
// package reads the registry, where .js may map to text/plain and the WebView
// would then refuse the module scripts because of nosniff.
var staticTypes = map[string]string{
	".css":   "text/css; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".ico":   "image/x-icon",
	".jpg":   "image/jpeg",
	".js":    "text/javascript; charset=utf-8",
	".json":  "application/json",
	".map":   "application/json",
	".mjs":   "text/javascript; charset=utf-8",
	".png":   "image/png",
	".svg":   "image/svg+xml",
	".ttf":   "font/ttf",
	".txt":   "text/plain; charset=utf-8",
	".wasm":  "application/wasm",
	".webp":  "image/webp",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

func staticContentType(name string) string {
	extension := strings.ToLower(filepath.Ext(name))
	if contentType, ok := staticTypes[extension]; ok {
		return contentType
	}
	return mime.TypeByExtension(extension)
}

func safeRequestPath(request *http.Request) (string, bool) {
	raw := request.URL.EscapedPath()
	decoded, err := url.PathUnescape(raw)
	if err != nil || strings.ContainsRune(decoded, 0) || strings.Contains(decoded, `\`) {
		return "", false
	}
	trimmed := strings.TrimPrefix(decoded, "/")
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == ".." || strings.HasPrefix(segment, ".") {
			return "", false
		}
	}
	return strings.TrimPrefix(filepath.ToSlash(filepath.Clean("/"+trimmed)), "/"), true
}

func (server *Server) resolveStatic(target string) (string, os.FileInfo, bool) {
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", nil, false
	}
	relative, err := filepath.Rel(server.staticRoot, resolved)
	if err != nil || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", nil, false
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, false
	}
	return resolved, info, true
}

type PairDevice struct {
	Name     string `json:"name"`
	Model    string `json:"model"`
	Platform string `json:"platform"`
	App      string `json:"app"`
	NodeKey  string `json:"nodeKey"`
}

type pairRequest struct {
	Version int        `json:"v"`
	PairID  string     `json:"pairId"`
	Secret  string     `json:"secret"`
	Device  PairDevice `json:"device"`
}

func (server *Server) servePair(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	remoteIP := addressHost(request.RemoteAddr)
	if !server.allowPair(remoteIP) {
		server.writeProblem(response, http.StatusTooManyRequests, "pair_rate_limited", "Muitas tentativas de pareamento. Gere um novo código e tente novamente.")
		return
	}
	var input pairRequest
	request.Body = http.MaxBytesReader(response, request.Body, MaxPairBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Version != 1 || input.PairID == "" || input.Secret == "" || input.Device.NodeKey == "" {
		server.writeProblem(response, http.StatusBadRequest, "payload_invalid", "A solicitação de pareamento é inválida.")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		server.writeProblem(response, http.StatusBadRequest, "payload_invalid", "A solicitação de pareamento contém dados adicionais.")
		return
	}
	verified, err := server.config.Sessions.Verify(input.PairID, input.Secret)
	if err != nil {
		server.writePairingError(response, err)
		return
	}
	identity, err := server.config.WhoIs.WhoIs(request.Context(), request.RemoteAddr)
	if err != nil || identity.NodeKey == "" || identity.NodeKey != input.Device.NodeKey || identity.UserID != verified.UserID {
		server.writeProblem(response, http.StatusForbidden, "pair_node_mismatch", "A identidade do dispositivo não confere com a conexão segura.")
		server.emit("pair.failed", map[string]string{"pairId": input.PairID, "code": "pair_node_mismatch"})
		return
	}
	if server.config.RequireApproval {
		if server.config.Approver == nil {
			server.writeProblem(response, http.StatusServiceUnavailable, "pair_timeout", "O computador não respondeu ao pedido de pareamento.")
			return
		}
		approval := ApprovalRequest{PairID: input.PairID, Device: input.Device, Peer: identity, Until: server.config.Now().Add(time.Minute)}
		approvalContext, cancel := context.WithTimeout(request.Context(), time.Minute)
		err := server.config.Approver.Await(approvalContext, approval)
		cancel()
		if err != nil {
			code := pairing.Code(err)
			if code != "pair_timeout" {
				code = "pair_denied"
			}
			server.writeProblem(response, http.StatusForbidden, code, "O computador não aprovou este pareamento.")
			return
		}
	}
	consumed, err := server.config.Sessions.Consume(input.PairID, input.Secret)
	if err != nil {
		server.writePairingError(response, err)
		return
	}
	ip := identity.IP
	if ip == "" {
		ip = remoteIP
	}
	device, token, err := server.config.Devices.Pair(pairing.DeviceInput{
		Name: input.Device.Name, Model: input.Device.Model, Platform: input.Device.Platform, App: input.Device.App,
		NodeKey: input.Device.NodeKey, NodeID: identity.NodeID, UserID: identity.UserID, IP4: ip, RemoteAddr: request.RemoteAddr,
	})
	if err != nil {
		server.writeProblem(response, http.StatusInternalServerError, "pair_internal", "Não foi possível salvar o dispositivo pareado.")
		return
	}
	issuedAt := server.config.Now().UTC()
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(map[string]any{
		"deviceId": device.ID, "token": token,
		"desktop":  map[string]any{"id": server.config.Desktop.ID, "name": server.config.Desktop.Name, "port": server.config.Port},
		"issuedAt": issuedAt.Format(time.RFC3339),
	})
	server.emit("pair.completed", map[string]any{"pairId": input.PairID, "device": device})
	if server.config.KeyExpirer != nil {
		go func(keyID uint64) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = server.config.KeyExpirer.ExpirePreAuthKey(ctx, keyID)
		}(consumed.PreAuthKeyID)
	}
}

func addressHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

func (server *Server) allowPair(ip string) bool {
	now := server.config.Now()
	server.rateMu.Lock()
	defer server.rateMu.Unlock()
	window := server.rates[ip]
	if window.started.IsZero() || now.Sub(window.started) >= time.Minute || now.Before(window.started) {
		window = rateWindow{started: now}
	}
	if window.count >= MaxPairingsPerMin {
		server.rates[ip] = window
		return false
	}
	window.count++
	server.rates[ip] = window
	return true
}

func (server *Server) writePairingError(response http.ResponseWriter, err error) {
	code := pairing.Code(err)
	status := http.StatusBadRequest
	switch code {
	case "pair_unknown":
		status = http.StatusNotFound
	case "pair_secret_mismatch":
		status = http.StatusUnauthorized
	case "pair_consumed", "pair_expired":
		status = http.StatusGone
	}
	server.writeProblem(response, status, code, err.Error())
}

func (server *Server) writeProblem(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func isUpgrade(request *http.Request) bool {
	return strings.EqualFold(request.Header.Get("Upgrade"), "websocket") && headerContainsToken(request.Header.Get("Connection"), "upgrade")
}

func headerContainsToken(value, token string) bool {
	for _, candidate := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(candidate), token) {
			return true
		}
	}
	return false
}

func (server *Server) serveUpgrade(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !isUpgrade(request) {
		server.writeProblem(response, http.StatusBadRequest, "upgrade_required", "Esta rota exige uma conexão WebSocket.")
		return
	}
	token := bearerToken(request.Header.Get("Authorization"))
	if token == "" {
		token = tokenFromProtocols(request.Header.Values("Sec-WebSocket-Protocol"))
	}
	device, ok := server.config.Devices.Authenticate(token)
	if !ok {
		server.writeProblem(response, http.StatusUnauthorized, "device_unauthorized", "O token deste dispositivo não foi aceito.")
		return
	}
	identity, err := server.config.WhoIs.WhoIs(request.Context(), request.RemoteAddr)
	if err != nil || identity.NodeKey != device.NodeKey || identity.UserID != device.UserID {
		server.writeProblem(response, http.StatusForbidden, "device_identity_mismatch", "A identidade desta conexão não corresponde ao dispositivo.")
		return
	}
	if err := server.config.Devices.MarkSeen(device.ID, request.RemoteAddr); err != nil {
		server.writeProblem(response, http.StatusInternalServerError, "device_state", "Não foi possível atualizar o estado deste dispositivo.")
		return
	}
	connection, _ := request.Context().Value(connectionContextKey{}).(net.Conn)
	release, ok := server.acquire(device.ID, connection)
	if !ok {
		server.writeProblem(response, http.StatusTooManyRequests, "socket_limit", "Este computador atingiu o limite de conexões móveis.")
		return
	}
	defer release()
	request.Header.Del("Authorization")
	removeTokenProtocol(request.Header, token)
	request = request.WithContext(context.WithValue(request.Context(), bridgeIdentityKey{}, bridgeIdentity{Device: device, Peer: identity}))
	server.emit("session.opened", map[string]string{"deviceId": device.ID, "remoteAddr": request.RemoteAddr, "nodeKey": identity.NodeKey})
	server.proxy.ServeHTTP(response, request)
	server.emit("session.closed", map[string]string{"deviceId": device.ID, "reason": "closed"})
}

func bearerToken(value string) string {
	const prefix = "Bearer "
	if len(value) <= len(prefix) || !strings.EqualFold(value[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(value[len(prefix):])
}

func tokenFromProtocols(values []string) string {
	for _, value := range values {
		for _, protocol := range strings.Split(value, ",") {
			candidate := strings.TrimSpace(protocol)
			if strings.HasPrefix(candidate, "cdt1.") {
				return candidate
			}
		}
	}
	return ""
}

func removeTokenProtocol(headers http.Header, token string) {
	var kept []string
	for _, value := range headers.Values("Sec-WebSocket-Protocol") {
		for _, protocol := range strings.Split(value, ",") {
			candidate := strings.TrimSpace(protocol)
			if candidate != "" && candidate != token {
				kept = append(kept, candidate)
			}
		}
	}
	headers.Del("Sec-WebSocket-Protocol")
	if len(kept) > 0 {
		headers.Set("Sec-WebSocket-Protocol", strings.Join(kept, ", "))
	}
}

type bridgeIdentityKey struct{}

type bridgeIdentity struct {
	Device pairing.Device
	Peer   node.Identity
}

func (server *Server) newBridgeProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			identity := request.In.Context().Value(bridgeIdentityKey{}).(bridgeIdentity)
			request.SetURL(server.bridge)
			request.Out.Host = server.bridge.Host
			for name := range request.Out.Header {
				if strings.HasPrefix(strings.ToLower(name), "x-cialai-") {
					request.Out.Header.Del(name)
				}
			}
			request.Out.Header.Del("Authorization")
			request.Out.Header.Set("X-Cialai-Proxy-Secret", server.config.ProxySecret)
			request.Out.Header.Set("X-Cialai-Device-Id", identity.Device.ID)
			request.Out.Header.Set("X-Cialai-Node-Key", identity.Peer.NodeKey)
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode != http.StatusSwitchingProtocols {
				return nil
			}
			identity, ok := response.Request.Context().Value(bridgeIdentityKey{}).(bridgeIdentity)
			if !ok || !server.config.Devices.TokenRotationDue(identity.Device.ID) {
				return nil
			}
			token, err := server.config.Devices.RotateToken(identity.Device.ID)
			if err != nil {
				return err
			}
			response.Header.Set("X-Cialai-Token-Next", token)
			return nil
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			server.writeProblem(response, http.StatusBadGateway, "bridge_unreachable", "A ponte local não está disponível.")
		},
	}
}

func (server *Server) acquire(deviceID string, connection net.Conn) (func(), bool) {
	server.activeMu.Lock()
	if server.total >= MaxBridgeSockets || server.activeCountLocked(deviceID) >= MaxDeviceSockets {
		server.activeMu.Unlock()
		return nil, false
	}
	if connection == nil {
		server.activeAnon[deviceID]++
	} else {
		if server.active[deviceID] == nil {
			server.active[deviceID] = make(map[net.Conn]struct{})
		}
		server.active[deviceID][connection] = struct{}{}
	}
	server.total++
	server.activeMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			server.activeMu.Lock()
			if connection == nil {
				server.activeAnon[deviceID]--
				if server.activeAnon[deviceID] == 0 {
					delete(server.activeAnon, deviceID)
				}
			} else if connections := server.active[deviceID]; connections != nil {
				delete(connections, connection)
				if len(connections) == 0 {
					delete(server.active, deviceID)
				}
			}
			server.total--
			server.activeMu.Unlock()
		})
	}, true
}

func (server *Server) activeCountLocked(deviceID string) int {
	return len(server.active[deviceID]) + server.activeAnon[deviceID]
}

func (server *Server) RevokeConnections(deviceID string) int {
	server.activeMu.Lock()
	connections := make([]net.Conn, 0, len(server.active[deviceID]))
	for connection := range server.active[deviceID] {
		connections = append(connections, connection)
	}
	server.activeMu.Unlock()
	for _, connection := range connections {
		_ = connection.Close()
	}
	return len(connections)
}

func (server *Server) emit(name string, data any) {
	if server.config.OnEvent != nil {
		server.config.OnEvent(name, data)
	}
}

func (server *Server) Serve(listener net.Listener) error {
	httpServer := &http.Server{
		Handler:           server,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       65 * time.Second,
		ConnContext: func(ctx context.Context, connection net.Conn) context.Context {
			return context.WithValue(ctx, connectionContextKey{}, connection)
		},
	}
	server.httpMu.Lock()
	if server.httpServer != nil {
		server.httpMu.Unlock()
		return errors.New("edge server is already running")
	}
	server.httpServer = httpServer
	server.httpMu.Unlock()
	err := httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (server *Server) Close(ctx context.Context) error {
	server.httpMu.Lock()
	httpServer := server.httpServer
	server.httpMu.Unlock()
	if httpServer == nil {
		return nil
	}
	return httpServer.Shutdown(ctx)
}
