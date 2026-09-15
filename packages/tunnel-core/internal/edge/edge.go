// SPDX-License-Identifier: Apache-2.0
// Package edge serves the mobile site over the streams of every Cialai
// transport and forwards authenticated WebSocket upgrades to the desktop bridge
// on loopback. The peer identity is the Ed25519 key the transport session
// proved over mutual TLS. A session whose key is not registered only reaches
// POST /pair; every other route answers 401 pair_required until the pairing
// registers the key and the session is promoted.
package edge

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

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const (
	PairVersion       = 2
	MaxPairBodyBytes  = 16 * 1024
	MaxPairingsPerMin = 5
	MaxDeviceSockets  = 2
	MaxBridgeSockets  = 8
	defaultCSP        = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'self' blob:"
	approvalTimeout   = time.Minute
	// pairFailureGrace lets the error response reach the phone before a
	// failed pairing closes its restricted session.
	pairFailureGrace = time.Second
	// revokeGrace bounds how long a revocation waits for the bridge sockets
	// of the device to end after the bridge closed them with 4401, so the
	// whole revocation stays under one second even when the phone does not
	// answer the close.
	revokeGrace = 500 * time.Millisecond
)

// ApprovalRequest asks the desktop to confirm a pairing. Device.PublicKey is
// the key proven by the transport session.
type ApprovalRequest struct {
	PairID    string     `json:"pairId"`
	Device    PairDevice `json:"device"`
	Transport string     `json:"transport"`
	Until     time.Time  `json:"until"`
}

type Approver interface {
	Await(context.Context, ApprovalRequest) error
}

type EventSink func(name string, data any)

// ReachCard tells a paired phone how to reach this desktop again: the onion
// address, the desktop public key to pin and the direct candidates.
type ReachCard struct {
	Onion      string              `json:"onion"`
	PublicKey  string              `json:"publicKey"`
	Candidates []pairing.Candidate `json:"candidates"`
}

// Config wires the edge. The transport listeners are handed to Serve.
type Config struct {
	StaticDir   string
	BridgeURL   string
	ProxySecret string
	// Desktop is the identity phones pin: id, name and public key.
	Desktop pairing.Desktop
	// Reach returns the current onion address and direct candidates; the edge
	// fills the public key from Desktop.
	Reach           func() ReachCard
	CSP             string
	Sessions        *pairing.Sessions
	Devices         *pairing.Registry
	RequireApproval bool
	Approver        Approver
	OnEvent         EventSink
	Now             func() time.Time
}

// RevokeResult counts what a revocation closed.
type RevokeResult struct {
	// Sessions is the number of transport sessions of the device key closed
	// on every listener.
	Sessions int
	// Sockets is the number of bridge sockets of the device that were still
	// open when the grace ended and were closed directly, without the 4401
	// close reaching the phone for sure.
	Sockets int
}

type rateWindow struct {
	started time.Time
	count   int
}

type streamContextKey struct{}

type Server struct {
	config           Config
	staticRoot       string
	bridge           *url.URL
	proxy            *httputil.ReverseProxy
	pairFailureGrace time.Duration
	revokeGrace      time.Duration

	rateMu sync.Mutex
	rates  map[string]rateWindow

	activeMu sync.Mutex
	active   map[string]map[net.Conn]struct{}
	total    int
	// idle holds, per device, a channel closed when its last bridge socket
	// ends; a revocation waits on it.
	idle map[string]chan struct{}

	serveMu    sync.Mutex
	listener   transport.Listener
	httpServer *http.Server
	closed     bool
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
	if strings.TrimSpace(config.ProxySecret) == "" || config.Sessions == nil || config.Devices == nil || config.Reach == nil {
		return nil, errors.New("edge dependencies are required")
	}
	if config.Desktop.ID == "" || config.Desktop.Name == "" {
		return nil, errors.New("desktop identity is required")
	}
	if _, err := identity.ParsePublicKey(config.Desktop.PublicKey); err != nil {
		return nil, fmt.Errorf("desktop public key: %w", err)
	}
	if config.CSP == "" {
		config.CSP = defaultCSP
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	server := &Server{
		config: config, staticRoot: root, bridge: bridge, pairFailureGrace: pairFailureGrace, revokeGrace: revokeGrace,
		rates: make(map[string]rateWindow), active: make(map[string]map[net.Conn]struct{}), idle: make(map[string]chan struct{}),
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

// ServeHTTP routes one request by the registration of its transport session.
// A request that did not arrive on a transport stream has no peer identity
// and is treated as unregistered.
func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.securityHeaders(response)
	session := sessionOf(request)
	if session == nil || !server.registered(session) {
		server.serveRestricted(response, request, session)
		return
	}
	switch request.URL.Path {
	case "/api/health":
		server.serveHealth(response, request)
	case "/pair":
		server.servePair(response, request, session)
	case "/pty":
		server.serveUpgrade(response, request, session)
	case "/":
		if isUpgrade(request) {
			server.serveUpgrade(response, request, session)
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

// serveRestricted is the router of unregistered sessions: only POST /pair
// exists.
func (server *Server) serveRestricted(response http.ResponseWriter, request *http.Request, session transport.Session) {
	if session != nil && request.URL.Path == "/pair" && request.Method == http.MethodPost {
		server.servePair(response, request, session)
		return
	}
	server.writeProblem(response, http.StatusUnauthorized, "pair_required", "Pareie este celular com o computador antes de continuar.")
}

// registered reports whether the session may use the normal routes: the key
// must still be in the registry and the transport must have promoted the
// session. A key registered through another session is promoted here.
func (server *Server) registered(session transport.Session) bool {
	if _, ok := server.config.Devices.RegisteredKey(session.PeerKey()); !ok {
		return false
	}
	if session.Registered() {
		return true
	}
	if listener := server.currentListener(); listener != nil {
		listener.Promote(session.PeerKey())
	}
	return session.Registered()
}

func sessionOf(request *http.Request) transport.Session {
	stream, ok := request.Context().Value(streamContextKey{}).(transport.Stream)
	if !ok || stream == nil {
		return nil
	}
	return stream.Session()
}

func streamOf(request *http.Request) net.Conn {
	stream, _ := request.Context().Value(streamContextKey{}).(transport.Stream)
	if stream == nil {
		return nil
	}
	return stream
}

// sessionRemoteAddr is the phone address recorded in the registry. Sessions
// from the local Tor process carry no useful address, so it stays empty.
func sessionRemoteAddr(session transport.Session) string {
	if session.Transport() == transport.NameTor {
		return ""
	}
	address := session.RemoteAddr()
	if address == nil {
		return ""
	}
	return address.String()
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

// PairDevice is the phone identity sent to POST /pair. PublicKey must be the
// canonical key proven by the transport session.
type PairDevice struct {
	Name      string `json:"name"`
	Model     string `json:"model"`
	Platform  string `json:"platform"`
	App       string `json:"app"`
	PublicKey string `json:"publicKey"`
}

type pairRequest struct {
	Version int        `json:"v"`
	PairID  string     `json:"pairId"`
	Secret  string     `json:"secret"`
	Device  PairDevice `json:"device"`
}

func (server *Server) servePair(response http.ResponseWriter, request *http.Request, session transport.Session) {
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	fail := func(pairID string, status int, code, message string) {
		server.failPair(response, session, pairID, status, code, message)
	}
	if !server.allowPair(pairOrigin(session)) {
		fail("", http.StatusTooManyRequests, "pair_rate_limited", "Muitas tentativas de pareamento. Gere um novo código e tente novamente.")
		return
	}
	var input pairRequest
	request.Body = http.MaxBytesReader(response, request.Body, MaxPairBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Version != PairVersion || input.PairID == "" || input.Secret == "" || input.Device.PublicKey == "" {
		fail(input.PairID, http.StatusBadRequest, "payload_invalid", "A solicitação de pareamento é inválida.")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		fail(input.PairID, http.StatusBadRequest, "payload_invalid", "A solicitação de pareamento contém dados adicionais.")
		return
	}
	// Both sides are canonical base64url, so a different spelling of the
	// same key is also refused.
	if input.Device.PublicKey != session.PeerKey() {
		fail(input.PairID, http.StatusForbidden, "pair_key_mismatch", "A chave do aparelho não confere com a conexão segura.")
		return
	}
	if _, err := server.config.Sessions.Verify(input.PairID, input.Secret); err != nil {
		status, code := pairingErrorStatus(err)
		fail(input.PairID, status, code, err.Error())
		return
	}
	if server.config.RequireApproval {
		if server.config.Approver == nil {
			fail(input.PairID, http.StatusServiceUnavailable, "pair_timeout", "O computador não respondeu ao pedido de pareamento.")
			return
		}
		approval := ApprovalRequest{PairID: input.PairID, Device: input.Device, Transport: session.Transport(), Until: server.config.Now().Add(approvalTimeout)}
		approvalContext, cancel := context.WithTimeout(request.Context(), approvalTimeout)
		err := server.config.Approver.Await(approvalContext, approval)
		cancel()
		if err != nil {
			code := pairing.Code(err)
			if code != "pair_timeout" {
				code = "pair_denied"
			}
			fail(input.PairID, http.StatusForbidden, code, "O computador não aprovou este pareamento.")
			return
		}
	}
	// The restricted session may have expired during the approval; the QR
	// stays usable for a new connection instead of registering a phone that
	// can no longer receive its token.
	select {
	case <-session.Done():
		fail(input.PairID, http.StatusGone, "pair_session_closed", "A conexão de pareamento foi encerrada.")
		return
	default:
	}
	if _, err := server.config.Sessions.Consume(input.PairID, input.Secret); err != nil {
		status, code := pairingErrorStatus(err)
		fail(input.PairID, status, code, err.Error())
		return
	}
	device, token, err := server.config.Devices.Pair(pairing.DeviceInput{
		Name: input.Device.Name, Model: input.Device.Model, Platform: input.Device.Platform, App: input.Device.App,
		DeviceKey: session.PeerKey(), Transport: session.Transport(), RemoteAddr: sessionRemoteAddr(session),
	})
	if err != nil {
		fail(input.PairID, http.StatusInternalServerError, "pair_internal", "Não foi possível salvar o dispositivo pareado.")
		return
	}
	promoted := 0
	if listener := server.currentListener(); listener != nil {
		promoted = listener.Promote(session.PeerKey())
	}
	card := server.config.Reach()
	card.PublicKey = server.config.Desktop.PublicKey
	if card.Candidates == nil {
		card.Candidates = []pairing.Candidate{}
	}
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(map[string]any{
		"deviceId": device.ID, "token": token,
		"desktop":  map[string]string{"id": server.config.Desktop.ID, "name": server.config.Desktop.Name, "publicKey": server.config.Desktop.PublicKey},
		"reach":    card,
		"issuedAt": server.config.Now().UTC().Format(time.RFC3339),
	})
	server.emit("pair.completed", map[string]any{"pairId": input.PairID, "device": device, "transport": session.Transport(), "promoted": promoted > 0})
}

// failPair answers a failed pairing. A failure closes an unregistered
// session: the HTTP connection ends after the response and the transport
// session shortly after, once the response had time to leave.
func (server *Server) failPair(response http.ResponseWriter, session transport.Session, pairID string, status int, code, message string) {
	if !session.Registered() {
		response.Header().Set("Connection", "close")
		time.AfterFunc(server.pairFailureGrace, func() {
			if !session.Registered() {
				_ = session.Close()
			}
		})
	}
	server.writeProblem(response, status, code, message)
	server.emit("pair.failed", map[string]string{"pairId": pairID, "code": code, "transport": session.Transport()})
}

// pairOrigin keys the pairing rate limit. Every onion session comes from the
// local Tor process, so Tor pairings share one window.
func pairOrigin(session transport.Session) string {
	if session.Transport() == transport.NameTor {
		return transport.NameTor
	}
	address := session.RemoteAddr()
	if address == nil {
		return session.Transport()
	}
	return session.Transport() + "|" + addressHost(address.String())
}

func addressHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

func (server *Server) allowPair(origin string) bool {
	now := server.config.Now()
	server.rateMu.Lock()
	defer server.rateMu.Unlock()
	window := server.rates[origin]
	if window.started.IsZero() || now.Sub(window.started) >= time.Minute || now.Before(window.started) {
		window = rateWindow{started: now}
	}
	if window.count >= MaxPairingsPerMin {
		server.rates[origin] = window
		return false
	}
	window.count++
	server.rates[origin] = window
	return true
}

func pairingErrorStatus(err error) (int, string) {
	code := pairing.Code(err)
	switch code {
	case "pair_unknown":
		return http.StatusNotFound, code
	case "pair_secret_mismatch":
		return http.StatusUnauthorized, code
	case "pair_consumed", "pair_expired":
		return http.StatusGone, code
	case "":
		return http.StatusBadRequest, "pair_internal"
	}
	return http.StatusBadRequest, code
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

func (server *Server) serveUpgrade(response http.ResponseWriter, request *http.Request, session transport.Session) {
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
	if device.DeviceKey != session.PeerKey() {
		server.writeProblem(response, http.StatusForbidden, "device_identity_mismatch", "A identidade desta conexão não corresponde ao dispositivo.")
		return
	}
	remoteAddr := sessionRemoteAddr(session)
	if err := server.config.Devices.MarkSeen(device.ID, session.Transport(), remoteAddr); err != nil {
		server.writeProblem(response, http.StatusInternalServerError, "device_state", "Não foi possível atualizar o estado deste dispositivo.")
		return
	}
	release, ok := server.acquire(device.ID, streamOf(request))
	if !ok {
		server.writeProblem(response, http.StatusTooManyRequests, "socket_limit", "Este computador atingiu o limite de conexões móveis.")
		return
	}
	defer release()
	request.Header.Del("Authorization")
	removeTokenProtocol(request.Header, token)
	request = request.WithContext(context.WithValue(request.Context(), bridgeIdentityKey{}, bridgeIdentity{Device: device, Transport: session.Transport()}))
	server.emit("session.opened", map[string]string{"deviceId": device.ID, "transport": session.Transport(), "remoteAddr": remoteAddr, "deviceKey": device.DeviceKey})
	server.proxy.ServeHTTP(response, request)
	reason := "closed"
	if _, registered := server.config.Devices.RegisteredKey(device.DeviceKey); !registered {
		reason = "revoked"
	}
	server.emit("session.closed", map[string]string{"deviceId": device.ID, "transport": session.Transport(), "reason": reason})
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
	Device    pairing.Device
	Transport string
}

// newBridgeProxy forwards to the bridge with the trusted identity headers.
// X-Cialai-Node-Key repeats the device key until the bridge reads
// X-Cialai-Device-Key (CON-045).
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
			request.Out.Header.Set("X-Cialai-Device-Key", identity.Device.DeviceKey)
			request.Out.Header.Set("X-Cialai-Node-Key", identity.Device.DeviceKey)
			request.Out.Header.Set("X-Cialai-Transport", identity.Transport)
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
	if connection == nil {
		return nil, false
	}
	server.activeMu.Lock()
	if server.total >= MaxBridgeSockets || len(server.active[deviceID]) >= MaxDeviceSockets {
		server.activeMu.Unlock()
		return nil, false
	}
	if server.active[deviceID] == nil {
		server.active[deviceID] = make(map[net.Conn]struct{})
	}
	server.active[deviceID][connection] = struct{}{}
	server.total++
	server.activeMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			server.activeMu.Lock()
			if connections := server.active[deviceID]; connections != nil {
				delete(connections, connection)
				if len(connections) == 0 {
					delete(server.active, deviceID)
					if idle := server.idle[deviceID]; idle != nil {
						close(idle)
						delete(server.idle, deviceID)
					}
				}
			}
			server.total--
			server.activeMu.Unlock()
		})
	}, true
}

// Revoke revokes a device on every transport; the sidecar calls it for
// devices.revoke and must not emit devices.changed for it again. In order:
//
//  1. The registry marks the device revoked, which removes its key from the
//     accepted set: new handshakes of the key are refused outside pairing,
//     new streams of its sessions are refused by the listeners and new
//     requests and upgrades by the edge.
//  2. devices.changed with revoked true tells the bridge, through the
//     desktop supervisor, to close the WebSockets of the device with 4401.
//  3. Revoke waits until those sockets end, both directions included, or
//     revokeGrace passes. Closing a QUIC session discards the data the phone
//     has not read yet, so cutting the transport first would lose the 4401
//     close and the page would retry instead of showing "removido".
//  4. transport.Listener.CloseKey closes the sessions of the key on every
//     listener and the bridge sockets still counted for the device are
//     closed directly.
//
// Revoke returns once the sessions are closed, at most revokeGrace plus the
// closing itself after it starts. Revoking a device again repeats the closing
// steps and keeps the first revocation time.
func (server *Server) Revoke(deviceID string) (RevokeResult, error) {
	device, found := server.config.Devices.Get(deviceID)
	if !found {
		return RevokeResult{}, errors.New("device not found")
	}
	if err := server.config.Devices.Revoke(deviceID); err != nil {
		return RevokeResult{}, err
	}
	server.emit("devices.changed", map[string]any{"deviceId": deviceID, "revoked": true})
	server.awaitDeviceSockets(deviceID, server.revokeGrace)
	var result RevokeResult
	if listener := server.currentListener(); listener != nil {
		result.Sessions = listener.CloseKey(device.DeviceKey)
	}
	result.Sockets = server.closeDeviceSockets(deviceID)
	return result, nil
}

// awaitDeviceSockets waits until the device has no bridge socket left or grace
// passes.
func (server *Server) awaitDeviceSockets(deviceID string, grace time.Duration) {
	server.activeMu.Lock()
	if len(server.active[deviceID]) == 0 {
		server.activeMu.Unlock()
		return
	}
	idle := server.idle[deviceID]
	if idle == nil {
		idle = make(chan struct{})
		server.idle[deviceID] = idle
	}
	server.activeMu.Unlock()
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-idle:
	case <-timer.C:
	}
}

func (server *Server) closeDeviceSockets(deviceID string) int {
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

func (server *Server) currentListener() transport.Listener {
	server.serveMu.Lock()
	defer server.serveMu.Unlock()
	return server.listener
}

// Serve accepts sessions from listener and serves HTTP on their streams until
// Close. The listener is usually a transport.MultiListener joining the direct
// and onion listeners. Serve owns it: Close closes it. Serve returns nil after
// Close and an error when the listener stops by itself.
func (server *Server) Serve(listener transport.Listener) error {
	if listener == nil {
		return errors.New("edge needs a transport listener")
	}
	streams := newStreamListener(listener.Addr())
	httpServer := &http.Server{
		Handler:           server,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       65 * time.Second,
		ConnContext: func(ctx context.Context, connection net.Conn) context.Context {
			return context.WithValue(ctx, streamContextKey{}, connection)
		},
	}
	server.serveMu.Lock()
	if server.closed {
		server.serveMu.Unlock()
		return errors.New("edge server is closed")
	}
	if server.httpServer != nil {
		server.serveMu.Unlock()
		return errors.New("edge server is already running")
	}
	server.httpServer = httpServer
	server.listener = listener
	server.serveMu.Unlock()
	go server.acceptSessions(listener, streams)
	err := httpServer.Serve(streams)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (server *Server) acceptSessions(listener transport.Listener, streams *streamListener) {
	for {
		session, err := listener.Accept(streams.ctx)
		if err != nil {
			streams.stop(fmt.Errorf("edge transport listener stopped: %w", err))
			return
		}
		go acceptStreams(session, streams)
	}
}

func acceptStreams(session transport.Session, streams *streamListener) {
	for {
		stream, err := session.AcceptStream(streams.ctx)
		if err != nil {
			return
		}
		if !streams.deliver(stream) {
			_ = stream.Close()
			return
		}
	}
}

// Close shuts the HTTP server down gracefully, then closes the transport
// listener and with it every session.
func (server *Server) Close(ctx context.Context) error {
	server.serveMu.Lock()
	server.closed = true
	httpServer, listener := server.httpServer, server.listener
	server.serveMu.Unlock()
	var err error
	if httpServer != nil {
		err = httpServer.Shutdown(ctx)
	}
	if listener != nil {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, transport.ErrClosed) {
			err = errors.Join(err, closeErr)
		}
	}
	return err
}

// streamListener hands transport streams to net/http as connections.
type streamListener struct {
	addr    net.Addr
	streams chan net.Conn
	ctx     context.Context
	cancel  context.CancelCauseFunc
}

func newStreamListener(addr net.Addr) *streamListener {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &streamListener{addr: addr, streams: make(chan net.Conn), ctx: ctx, cancel: cancel}
}

func (listener *streamListener) Accept() (net.Conn, error) {
	select {
	case stream := <-listener.streams:
		return stream, nil
	case <-listener.ctx.Done():
		return nil, context.Cause(listener.ctx)
	}
}

func (listener *streamListener) deliver(stream net.Conn) bool {
	select {
	case listener.streams <- stream:
		return true
	case <-listener.ctx.Done():
		return false
	}
}

func (listener *streamListener) stop(err error) { listener.cancel(err) }

func (listener *streamListener) Close() error {
	listener.cancel(net.ErrClosed)
	return nil
}

func (listener *streamListener) Addr() net.Addr { return listener.addr }
