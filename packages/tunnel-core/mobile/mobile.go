// SPDX-License-Identifier: Apache-2.0
// Package mobile is the gomobile boundary used by the iOS and Android shells.
// The phone holds an Ed25519 identity, remembers the reach card of each paired
// desktop and reaches it through the path manager: the local network and the
// direct internet path over QUIC, or the Tor fallback through the SOCKS
// listener of the Tor the native side runs. The loopback proxy serves the
// desktop page over whichever path is active.
//
// Only types accepted by gobind cross the boundary; structured values are
// JSON. Errors read "code: message", and the native side hands the code to
// TypeScript. Device tokens are never persisted by this package.
//
// Events delivered to Listener.OnEvent:
//
//	state  status snapshot as in StatusJSON, with desktopId and code when
//	       offline; {"legacyDiscarded":true} once after discarding version 1
//	path   {desktopId, transport, path, reason} each time the active path
//	       changes; path "none" carries the error code as reason
//	tor    {state, progress} of the Tor fallback
//	proxy  {state: open | closed | token-rotated | revoked, desktopId, ...};
//	       token-rotated carries deviceToken for the secure store
//	pair   {state: lan | direct | tor | confirming | completed, desktopId}
//	log    {level, message} filtered by SetLogLevel
package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/netip"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/mdns"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

const (
	version           = "0.2.0"
	proxyCloseTimeout = 5 * time.Second
)

const (
	levelError int32 = iota
	levelInfo
	levelDebug
)

var levelNames = []string{"error", "info", "debug"}

// Listener receives non-secret lifecycle events, except the rotated device
// token of proxy token-rotated. kind is one of state, path, tor, proxy, pair or
// log and payloadJSON is always a JSON object.
type Listener interface {
	OnEvent(kind string, payloadJSON string)
}

// Tunnel reaches the paired desktops of one app installation. At most one
// desktop has a path manager and a loopback proxy at a time; opening another
// desktop closes them.
type Tunnel struct {
	// opMu serializes the calls that replace the manager or the proxy.
	opMu sync.Mutex
	// pairMu keeps one pairing at a time.
	pairMu sync.Mutex

	paths    statedir.Paths
	listener Listener
	local    *identity.Identity
	tor      *tor.Client
	now      func() time.Time
	logLevel atomic.Int32

	// Seams for tests; NewTunnel sets the production values.
	timings      pathmgr.Timings
	listenPacket func() (net.PacketConn, error)
	pairRetry    time.Duration
	pairTorGrace time.Duration

	mu         sync.Mutex
	desktops   map[string]storedDesktop
	reported   map[string][]netip.AddrPort
	endpoint   *direct.Endpoint
	manager    *pathmgr.Manager
	managerID  string
	managerGen uint64
	proxy      *proxy.Proxy
	proxyID    string
	torStatus  pathmgr.TorStatus
	ctx        context.Context
	cancel     context.CancelFunc

	saveMu sync.Mutex
}

// Version identifies the Go mobile API and is safe to call before NewTunnel.
func Version() string { return version }

// NewTunnel opens the private mobile state: identity.key, which the native
// module excludes from backups, and mobile-state.json version 2. stateDir must
// be an absolute app data directory.
func NewTunnel(stateDir string, listener Listener) (*Tunnel, error) {
	if err := prepareQUIC(runtime.GOOS, os.Setenv); err != nil {
		return nil, err
	}
	paths, err := prepareRoot(stateDir)
	if err != nil {
		return nil, coded("state_invalid", err)
	}
	local, _, _, err := identity.Open(identity.Options{Role: identity.RolePhone, Dir: paths.Root})
	if err != nil {
		return nil, coded("identity_invalid", err)
	}
	desktops, legacy, err := loadState(paths)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	tunnel := &Tunnel{
		paths: paths, listener: listener, local: local, tor: tor.NewClient(), now: time.Now,
		listenPacket: listenUDP, pairRetry: pairTorRetry, pairTorGrace: pairTorGrace,
		desktops: desktops, reported: map[string][]netip.AddrPort{},
		torStatus: pathmgr.TorStatus{State: pathmgr.TorDisabled}, ctx: ctx, cancel: cancel,
	}
	tunnel.logLevel.Store(levelInfo)
	if legacy {
		tunnel.emit("state", map[string]any{"legacyDiscarded": true})
		tunnel.log(levelInfo, "discarded the mobile state of a previous Cialai version")
	}
	return tunnel, nil
}

// SetTorEndpoints hands over the listeners of the Tor the native side runs:
// SOCKS is required, control and cookiePath only serve bootstrap progress. Empty
// values clear them when that Tor stops.
func (tunnel *Tunnel) SetTorEndpoints(socksAddr, controlAddr, cookiePath string) error {
	endpoints := tor.Endpoints{SOCKS: socksAddr, Control: controlAddr, CookiePath: cookiePath}
	if err := tunnel.tor.SetTorEndpoints(endpoints); err != nil {
		return coded("tor_endpoints_invalid", err)
	}
	status := pathmgr.TorStatus{State: pathmgr.TorUnknown}
	if endpoints == (tor.Endpoints{}) {
		status.State = pathmgr.TorDisabled
	}
	tunnel.setTor(status)
	if status.State != pathmgr.TorDisabled {
		tunnel.reevaluateOffline()
	}
	return nil
}

// ReportLanCandidates replaces the addresses native DNS-SD discovery resolved
// for desktopID, as [{"host","port","id","fp"}].
func (tunnel *Tunnel) ReportLanCandidates(desktopID string, reportedJSON string) error {
	addresses, err := mdns.ParseReported(desktopID, []byte(reportedJSON))
	if err != nil {
		return coded("lan_report_invalid", err)
	}
	tunnel.mu.Lock()
	if _, known := tunnel.desktops[desktopID]; !known {
		tunnel.mu.Unlock()
		return desktopUnknown()
	}
	tunnel.reported[desktopID] = addresses
	var manager *pathmgr.Manager
	if tunnel.managerID == desktopID {
		manager = tunnel.manager
	}
	tunnel.mu.Unlock()
	if manager != nil {
		manager.SetReportedLAN(addresses)
		if len(addresses) > 0 {
			tunnel.reevaluateOffline()
		}
	}
	return nil
}

// Connect evaluates the paths to a paired desktop and waits until one is
// active or every step failed.
func (tunnel *Tunnel) Connect(desktopID string) (string, error) {
	tunnel.opMu.Lock()
	manager, err := tunnel.managerForLocked(desktopID)
	ctx := tunnel.context()
	tunnel.opMu.Unlock()
	if err != nil {
		return "", err
	}
	result, err := manager.Connect(ctx)
	if err != nil {
		tunnel.log(levelDebug, "connect to "+desktopID+" failed: "+err.Error())
		tunnel.emitState()
		return "", pathProblem(err)
	}
	tunnel.touch(desktopID, result.Transport)
	tunnel.emitState()
	return marshalJSON(result)
}

// OpenDesktop creates the authenticated loopback origin consumed by WebView.
// The proxy dials the desktop through the path manager.
func (tunnel *Tunnel) OpenDesktop(desktopID, deviceToken string, preferredPort int) (string, error) {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	manager, err := tunnel.managerForLocked(desktopID)
	if err != nil {
		return "", err
	}
	tunnel.mu.Lock()
	previous, previousID := tunnel.proxy, tunnel.proxyID
	tunnel.proxy, tunnel.proxyID = nil, ""
	tunnel.mu.Unlock()
	tunnel.closeProxy(previous, previousID)
	instance, err := proxy.New(proxy.Config{
		Dialer: manager, DesktopID: desktopID, DeviceToken: deviceToken,
		OnToken: func(next string) error {
			tunnel.emit("proxy", map[string]any{"state": "token-rotated", "desktopId": desktopID, "deviceToken": next})
			return nil
		},
		OnRevoked: func() {
			tunnel.emit("proxy", map[string]any{"state": "revoked", "desktopId": desktopID})
		},
	})
	if err != nil {
		return "", coded("proxy_invalid", err)
	}
	if preferredPort < 0 || preferredPort > 65535 {
		preferredPort = 0
	}
	opened, err := instance.Open(preferredPort)
	if err != nil {
		return "", coded("proxy_open_failed", err)
	}
	tunnel.mu.Lock()
	tunnel.proxy, tunnel.proxyID = instance, desktopID
	tunnel.mu.Unlock()
	event := map[string]any{"state": "open", "desktopId": desktopID, "port": opened.Port}
	if opened.Warning != "" {
		event["warning"] = opened.Warning
	}
	tunnel.emit("proxy", event)
	return marshalJSON(opened)
}

// CloseDesktop closes the proxy and the path of desktopID.
func (tunnel *Tunnel) CloseDesktop(desktopID string) error {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	tunnel.mu.Lock()
	if tunnel.proxyID != "" && tunnel.proxyID != desktopID {
		tunnel.mu.Unlock()
		return codedMessage("desktop_not_open", "Este computador não está aberto no proxy local.")
	}
	if tunnel.managerID != desktopID {
		tunnel.mu.Unlock()
		return nil
	}
	manager, instance, proxyID := tunnel.detachLocked()
	tunnel.mu.Unlock()
	tunnel.release(manager, instance, proxyID)
	tunnel.emitState()
	return nil
}

// Stop cancels pairings and connections in progress and closes the proxy, the
// path and the QUIC socket. A later Connect starts them again.
func (tunnel *Tunnel) Stop() error {
	tunnel.mu.Lock()
	tunnel.cancel()
	tunnel.ctx, tunnel.cancel = context.WithCancel(context.Background())
	tunnel.mu.Unlock()
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	tunnel.mu.Lock()
	manager, instance, proxyID := tunnel.detachLocked()
	endpoint := tunnel.endpoint
	tunnel.endpoint = nil
	tunnel.mu.Unlock()
	tunnel.release(manager, instance, proxyID)
	var err error
	if endpoint != nil {
		if closeErr := endpoint.Close(); closeErr != nil {
			err = coded("stop_failed", closeErr)
		}
	}
	tunnel.emitState()
	return err
}

// StatusJSON returns the connection state, the active path and the fallback.
func (tunnel *Tunnel) StatusJSON() (string, error) {
	return marshalJSON(tunnel.status())
}

type desktopView struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Fingerprint   string    `json:"fingerprint"`
	PairedAt      time.Time `json:"pairedAt"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
	LastTransport string    `json:"lastTransport"`
}

// DesktopsJSON lists the paired desktops in pairing order.
func (tunnel *Tunnel) DesktopsJSON() (string, error) {
	tunnel.mu.Lock()
	views := make([]desktopView, 0, len(tunnel.desktops))
	for _, desktop := range tunnel.desktops {
		views = append(views, desktopView{
			ID: desktop.ID, Name: desktop.Name, Fingerprint: desktop.Fingerprint,
			PairedAt: desktop.PairedAt, LastSeenAt: desktop.LastSeenAt, LastTransport: desktop.LastTransport,
		})
	}
	tunnel.mu.Unlock()
	slices.SortFunc(views, func(left, right desktopView) int {
		if order := left.PairedAt.Compare(right.PairedAt); order != 0 {
			return order
		}
		return strings.Compare(left.ID, right.ID)
	})
	return marshalJSON(map[string]any{"desktops": views})
}

// NotifyNetworkChange reports that the phone network changed: the active
// direct session migrates, or the paths are evaluated again.
func (tunnel *Tunnel) NotifyNetworkChange(reachable bool) {
	if manager := tunnel.currentManager(); manager != nil {
		manager.NotifyNetworkChange(reachable)
	}
	tunnel.emitState()
}

// NotifyForeground refreshes the path on resume and re-dials the fallback when
// it is in use. Native code owns the platform background deadline and may call
// Stop before a later Connect.
func (tunnel *Tunnel) NotifyForeground(active bool) {
	if manager := tunnel.currentManager(); manager != nil {
		manager.NotifyForeground(active)
	}
	tunnel.emitState()
}

// ForgetDesktop drops the non-secret memory of a desktop and closes its path.
// The native side deletes the token.
func (tunnel *Tunnel) ForgetDesktop(desktopID string) error {
	tunnel.opMu.Lock()
	defer tunnel.opMu.Unlock()
	tunnel.mu.Lock()
	if _, known := tunnel.desktops[desktopID]; !known {
		tunnel.mu.Unlock()
		return nil
	}
	var manager *pathmgr.Manager
	var instance *proxy.Proxy
	var proxyID string
	if tunnel.managerID == desktopID {
		manager, instance, proxyID = tunnel.detachLocked()
	}
	delete(tunnel.desktops, desktopID)
	delete(tunnel.reported, desktopID)
	tunnel.mu.Unlock()
	tunnel.release(manager, instance, proxyID)
	err := tunnel.save()
	tunnel.emitState()
	return err
}

// SetLogLevel selects which log events are emitted: error, info or debug.
func (tunnel *Tunnel) SetLogLevel(level string) {
	if index := slices.Index(levelNames, level); index >= 0 {
		tunnel.logLevel.Store(int32(index))
	}
}

// managerForLocked returns the path manager of desktopID, replacing the manager
// and proxy of another desktop. The caller holds opMu.
func (tunnel *Tunnel) managerForLocked(desktopID string) (*pathmgr.Manager, error) {
	tunnel.mu.Lock()
	desktop, known := tunnel.desktops[desktopID]
	if !known {
		tunnel.mu.Unlock()
		return nil, desktopUnknown()
	}
	if tunnel.manager != nil && tunnel.managerID == desktopID {
		manager := tunnel.manager
		tunnel.mu.Unlock()
		return manager, nil
	}
	previous, previousProxy, previousProxyID := tunnel.detachLocked()
	tunnel.mu.Unlock()
	tunnel.release(previous, previousProxy, previousProxyID)

	card, err := desktop.card()
	if err != nil {
		return nil, coded("state_invalid", err)
	}
	endpoint, err := tunnel.ensureEndpoint()
	if err != nil {
		return nil, err
	}
	tunnel.mu.Lock()
	tunnel.managerGen++
	generation := tunnel.managerGen
	reported := slices.Clone(tunnel.reported[desktopID])
	tunnel.mu.Unlock()
	manager, err := pathmgr.New(pathmgr.Config{
		Card: card, Local: tunnel.local, Direct: endpoint, Tor: tunnel.tor,
		ListenPacket: tunnel.listenPacket, Timings: tunnel.timings,
		OnPath: func(event pathmgr.PathEvent) { tunnel.onPath(generation, event) },
		OnTor: func(status pathmgr.TorStatus) {
			if tunnel.currentGeneration() == generation {
				tunnel.setTor(status)
			}
		},
		Logf: func(format string, args ...any) { tunnel.log(levelDebug, fmt.Sprintf(format, args...)) },
	})
	if err != nil {
		return nil, coded("path_setup_failed", err)
	}
	manager.SetReportedLAN(reported)
	tunnel.mu.Lock()
	tunnel.manager, tunnel.managerID = manager, desktopID
	tunnel.mu.Unlock()
	return manager, nil
}

// detachLocked takes the manager and the proxy out of the tunnel; callbacks of
// the detached manager are ignored from then on. The caller holds mu and
// releases them after unlocking, because closing a manager waits for its
// callbacks.
func (tunnel *Tunnel) detachLocked() (*pathmgr.Manager, *proxy.Proxy, string) {
	manager, instance, proxyID := tunnel.manager, tunnel.proxy, tunnel.proxyID
	tunnel.manager, tunnel.managerID = nil, ""
	tunnel.proxy, tunnel.proxyID = nil, ""
	tunnel.managerGen++
	return manager, instance, proxyID
}

func (tunnel *Tunnel) release(manager *pathmgr.Manager, instance *proxy.Proxy, proxyID string) {
	tunnel.closeProxy(instance, proxyID)
	if manager != nil {
		_ = manager.Close()
	}
}

func (tunnel *Tunnel) closeProxy(instance *proxy.Proxy, desktopID string) {
	if instance == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), proxyCloseTimeout)
	defer cancel()
	if err := instance.Close(ctx); err != nil {
		tunnel.log(levelError, "closing the local proxy failed: "+err.Error())
	}
	tunnel.emit("proxy", map[string]any{"state": "closed", "desktopId": desktopID})
}

func (tunnel *Tunnel) ensureEndpoint() (*direct.Endpoint, error) {
	tunnel.mu.Lock()
	defer tunnel.mu.Unlock()
	if tunnel.endpoint != nil {
		return tunnel.endpoint, nil
	}
	packetConn, err := tunnel.listenPacket()
	if err != nil {
		return nil, coded("socket_failed", err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: packetConn, Identity: tunnel.local})
	if err != nil {
		_ = packetConn.Close()
		return nil, coded("socket_failed", err)
	}
	tunnel.endpoint = endpoint
	return endpoint, nil
}

func (tunnel *Tunnel) onPath(generation uint64, event pathmgr.PathEvent) {
	tunnel.mu.Lock()
	if generation != tunnel.managerGen {
		tunnel.mu.Unlock()
		return
	}
	instance := tunnel.proxy
	touched := false
	if desktop, known := tunnel.desktops[event.DesktopID]; known && event.Path != pathmgr.KindNone {
		desktop.LastSeenAt, desktop.LastTransport = tunnel.now().UTC().Truncate(time.Second), event.Transport
		tunnel.desktops[event.DesktopID] = desktop
		touched = true
	}
	tunnel.mu.Unlock()
	if instance != nil {
		if closed := instance.PathChanged(event); closed > 0 {
			tunnel.log(levelDebug, fmt.Sprintf("path change closed %d upstreams", closed))
		}
	}
	tunnel.emit("path", event)
	if touched {
		if err := tunnel.save(); err != nil {
			tunnel.log(levelError, err.Error())
		}
	}
	tunnel.emitState()
}

func (tunnel *Tunnel) touch(desktopID, transportName string) {
	tunnel.mu.Lock()
	desktop, known := tunnel.desktops[desktopID]
	if known {
		desktop.LastSeenAt, desktop.LastTransport = tunnel.now().UTC().Truncate(time.Second), transportName
		tunnel.desktops[desktopID] = desktop
	}
	tunnel.mu.Unlock()
	if known {
		if err := tunnel.save(); err != nil {
			tunnel.log(levelError, err.Error())
		}
	}
}

// reevaluateOffline gives an offline manager a new evaluation after something
// that may bring a path back, such as Tor starting.
func (tunnel *Tunnel) reevaluateOffline() {
	if manager := tunnel.currentManager(); manager != nil && manager.Status().State == pathmgr.StateOffline {
		manager.NotifyNetworkChange(true)
	}
}

func (tunnel *Tunnel) setTor(status pathmgr.TorStatus) {
	tunnel.mu.Lock()
	changed := tunnel.torStatus != status
	tunnel.torStatus = status
	tunnel.mu.Unlock()
	if changed {
		tunnel.emit("tor", status)
	}
}

func (tunnel *Tunnel) currentManager() *pathmgr.Manager {
	tunnel.mu.Lock()
	defer tunnel.mu.Unlock()
	return tunnel.manager
}

func (tunnel *Tunnel) currentGeneration() uint64 {
	tunnel.mu.Lock()
	defer tunnel.mu.Unlock()
	return tunnel.managerGen
}

func (tunnel *Tunnel) context() context.Context {
	tunnel.mu.Lock()
	defer tunnel.mu.Unlock()
	return tunnel.ctx
}

func (tunnel *Tunnel) save() error {
	tunnel.saveMu.Lock()
	defer tunnel.saveMu.Unlock()
	tunnel.mu.Lock()
	desktops := maps.Clone(tunnel.desktops)
	tunnel.mu.Unlock()
	return writeState(tunnel.paths, desktops)
}

type statusView struct {
	State string `json:"state"`
	// DesktopID and Code name the desktop of the manager and, while offline,
	// the reason no path reaches it.
	DesktopID string      `json:"desktopId,omitempty"`
	Code      string      `json:"code,omitempty"`
	Active    *activeView `json:"active,omitempty"`
	Tor       torView     `json:"tor"`
	Desktops  int         `json:"desktops"`
}

type activeView struct {
	DesktopID string    `json:"desktopId"`
	Transport string    `json:"transport"`
	Path      string    `json:"path"`
	Since     time.Time `json:"since"`
}

type torView struct {
	State    string `json:"state"`
	Progress int    `json:"progress"`
}

func (tunnel *Tunnel) status() statusView {
	tunnel.mu.Lock()
	manager, desktopID, torStatus, count := tunnel.manager, tunnel.managerID, tunnel.torStatus, len(tunnel.desktops)
	tunnel.mu.Unlock()
	view := statusView{State: string(pathmgr.StateIdle), Tor: torView{State: torStatus.State, Progress: torStatus.Progress}, Desktops: count}
	if manager == nil {
		return view
	}
	status := manager.Status()
	view.State, view.DesktopID = string(status.State), desktopID
	if status.Active != nil {
		view.Active = &activeView{
			DesktopID: status.Active.DesktopID, Transport: status.Active.Transport,
			Path: string(status.Active.Kind), Since: status.Active.Since.UTC(),
		}
	}
	if status.State == pathmgr.StateOffline {
		view.Code = status.Error
	}
	return view
}

func (tunnel *Tunnel) emitState() { tunnel.emit("state", tunnel.status()) }

func (tunnel *Tunnel) emit(kind string, payload any) {
	if tunnel.listener == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err == nil {
		tunnel.listener.OnEvent(kind, string(raw))
	}
}

func (tunnel *Tunnel) log(level int32, message string) {
	if level <= tunnel.logLevel.Load() {
		tunnel.emit("log", map[string]string{"level": levelNames[level], "message": message})
	}
}

var pathMessages = map[string]string{
	pathmgr.CodeReserveUnavailable: "A conexão de reserva está indisponível e o computador não respondeu pelo caminho direto.",
	pathmgr.CodeReservePreparing:   "A conexão de reserva ainda está preparando. Tente de novo em instantes.",
	pathmgr.CodeNoPath:             "O computador não está acessível neste momento.",
	pathmgr.CodeRevoked:            "Este celular foi removido do computador. Pareie de novo.",
}

// pathProblem turns a path manager failure into a coded error.
func pathProblem(err error) error {
	if errors.Is(err, pathmgr.ErrClosed) || errors.Is(err, context.Canceled) {
		return codedMessage("stopped", "A conexão foi encerrada antes de concluir.")
	}
	code := pathmgr.Code(err)
	message, known := pathMessages[code]
	if !known {
		code, message = pathmgr.CodeNoPath, pathMessages[pathmgr.CodeNoPath]
	}
	return codedMessage(code, message)
}

func desktopUnknown() error {
	return codedMessage("desktop_unknown", "O computador solicitado não está pareado neste celular.")
}

func marshalJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", coded("json_failed", err)
	}
	return string(raw), nil
}

func coded(code string, err error) error {
	return fmt.Errorf("%s: %w", code, err)
}

func codedMessage(code, message string) error {
	return errors.New(code + ": " + message)
}
