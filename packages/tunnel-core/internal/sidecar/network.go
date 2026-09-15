// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"net"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/edge"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates/portmap"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/onion"
)

const (
	// DefaultDirectPort is the UDP port tried first for the direct listener.
	DefaultDirectPort = 4740
	// edgeCloseTimeout bounds the graceful HTTP shutdown of the edge.
	edgeCloseTimeout = 3 * time.Second
	// controlSendTimeout bounds one candidate or reach card update on a
	// control channel.
	controlSendTimeout = 5 * time.Second
	// controlCandidateTTL is the validity announced for the candidates sent on
	// a control channel; controlResend renews them well before it ends.
	controlCandidateTTL = rendezvous.MaxCandidateTTL
	controlResend       = rendezvous.MaxCandidateTTL / 2
)

// DefaultSTUNServers are asked through the QUIC socket when the gateway maps
// no port. net.start replaces them with its stun argument.
var DefaultSTUNServers = []string{"stun.cloudflare.com:3478", "stun.l.google.com:19302"}

// TorService is the supervised onion service; *tor.Desktop implements it.
type TorService interface {
	Address() string
	Listener() net.Listener
	State() tor.State
	Close() error
}

// AnnouncerConfig is what the local network announcer publishes: the
// desktop public key, from which the DNS-SD instance and the TXT id and
// fingerprint derive, and the UDP port of the direct listener.
type AnnouncerConfig struct {
	PublicKey ed25519.PublicKey
	Port      uint16
	Logf      func(format string, args ...any)
}

// Announcer publishes the direct listener on the local network by DNS-SD;
// *mdns.Announcer implements it. Refresh republishes on net.refresh and
// Close withdraws the announcement on net.stop.
type Announcer interface {
	Refresh() error
	Close() error
}

// NetworkConfig holds the defaults and seams of net.start. The zero value is
// the product: UDP 4740 on every interface, DefaultSTUNServers, the gateway
// port mapper, tor.StartDesktop and no local network announcer.
type NetworkConfig struct {
	// ListenHost binds the direct socket; empty means every interface.
	ListenHost string
	// PreferredPort is tried first; zero means DefaultDirectPort. A busy port
	// falls back to a free one.
	PreferredPort int
	// STUNServers replaces DefaultSTUNServers when not nil; an empty list
	// disables STUN.
	STUNServers []string
	// NewPortMapper creates the gateway mapper; nil means portmap.New. A nil
	// mapper without error disables mapping.
	NewPortMapper func(port uint16, logf func(string, ...any)) (candidates.PortMapper, error)
	// StartTor starts the onion service; nil means tor.StartDesktop.
	StartTor func(tor.DesktopConfig) (TorService, error)
	// NewAnnouncer plugs the mDNS announcer in, normally mdns.Start with the
	// fields of AnnouncerConfig. While it is nil, mdns.state stays disabled.
	NewAnnouncer func(AnnouncerConfig) (Announcer, error)
	// StateInterval spaces net.state events; zero means DefaultStateInterval.
	StateInterval time.Duration
}

// startConfig is everything one network run needs from the runtime.
type startConfig struct {
	paths           statedir.Paths
	logger          *logx.Logger
	identity        *identity.Identity
	desktop         pairing.Desktop
	devices         *pairing.Registry
	sessions        *pairing.Sessions
	approver        edge.Approver
	requireApproval bool
	staticDir       string
	bridgeURL       string
	proxySecret     string
	stunServers     []string
	torEnabled      bool
	torExecutable   string
	seams           NetworkConfig
	onEvent         func(name string, data any)
	onChange        func()
	onTorState      func(TorStatus)
}

// network is one run of the direct listener, candidates, Tor and edge, from
// net.start to net.stop. Its components are set before the edge serves and
// never replaced; the dynamic state is guarded by mu.
type network struct {
	config startConfig
	ctx    context.Context
	cancel context.CancelFunc

	onionAddress string
	endpoint     *direct.Endpoint
	direct       *direct.Listener
	port         int
	mapper       candidates.PortMapper
	collector    *candidates.Collector
	tor          TorService
	onion        *onion.Listener
	edge         *edge.Server
	edgeDone     chan struct{}
	announcer    Announcer
	first        chan struct{}
	firstOnce    sync.Once
	torLog       *lineLogger

	mu        sync.Mutex
	stopped   bool
	desktop   pairing.Desktop
	edgeState string
	torState  TorStatus
	mdnsState string
	live      map[string]map[string]int
	counts    SessionCounts
	controls  map[*controlPeer]struct{}
}

// startNetwork opens the direct socket, the candidates collector, Tor when
// enabled, the onion listener and the edge. A failure of the direct listener
// or of the edge closes what was opened and returns the error; a failure of
// Tor, the port mapper or the announcer only degrades the run.
func startNetwork(config startConfig) (*network, error) {
	ctx, cancel := context.WithCancel(context.Background())
	n := &network{
		config: config, ctx: ctx, cancel: cancel,
		edgeDone: make(chan struct{}), first: make(chan struct{}),
		desktop: config.desktop, edgeState: "stopped", mdnsState: "disabled",
		torState: TorStatus{State: torDisabled},
		live:     make(map[string]map[string]int), controls: make(map[*controlPeer]struct{}),
	}
	fail := func(code, message string, err error) (*network, error) {
		config.logger.Error("network start failed", logx.Fields{"code": code, "error": err.Error()})
		n.close()
		return nil, &serviceError{code: code, message: message, retryable: true, cause: err}
	}

	// The onion address derives from the persisted key, so it exists before
	// Tor runs and even when Tor is disabled.
	onionKey, _, err := tor.LoadOrCreateOnionKey(config.paths.OnionKey, nil)
	if err != nil {
		return fail("onion_key", "A chave do endereço de reserva não pôde ser lida.", err)
	}
	n.onionAddress = onionKey.Address()
	n.torState.Onion = n.onionAddress

	// The edge is built before any socket opens, so an invalid static
	// directory or bridge URL fails without touching the network.
	server, err := edge.New(edge.Config{
		StaticDir: config.staticDir, BridgeURL: config.bridgeURL, ProxySecret: config.proxySecret,
		Desktop: config.desktop, Reach: n.reach, Sessions: config.sessions, Devices: config.devices,
		RequireApproval: config.requireApproval, Approver: config.approver, OnEvent: config.onEvent,
	})
	if err != nil {
		cancel()
		return nil, &serviceError{code: "edge_failed", message: "A borda do celular não pôde ser preparada.", cause: err}
	}

	packetConn, err := listenDirect(config.seams.ListenHost, config.seams.PreferredPort)
	if err != nil {
		return fail("direct_listen", "O ouvinte direto não pôde abrir uma porta UDP.", err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: packetConn, Identity: config.identity})
	if err != nil {
		_ = packetConn.Close()
		return fail("direct_listen", "O ouvinte direto não pôde ser iniciado.", err)
	}
	n.endpoint = endpoint
	listener, err := endpoint.Listen(direct.ListenConfig{Registry: config.devices, Pairing: config.sessions})
	if err != nil {
		return fail("direct_listen", "O ouvinte direto não pôde ser iniciado.", err)
	}
	n.direct = listener
	n.port = udpPort(packetConn.LocalAddr())

	n.mapper = n.newPortMapper()
	collector, err := candidates.New(candidates.Config{
		Socket: endpoint, STUNServers: config.stunServers, PortMapper: n.mapper,
		OnChange: n.candidatesChanged, Logf: config.logger.Logf("debug"),
	})
	if err != nil {
		if n.mapper != nil {
			_ = n.mapper.Close()
			n.mapper = nil
		}
		n.close()
		return nil, &serviceError{code: "args_invalid", message: "A lista de servidores STUN é inválida.", cause: err}
	}
	n.collector = collector

	if config.torEnabled && config.torExecutable != "" {
		n.startTor()
	}

	listeners := []transport.Listener{n.direct}
	if n.onion != nil {
		listeners = append(listeners, n.onion)
	}
	tracked := &trackingListener{Listener: transport.NewMultiListener(listeners...), network: n}
	n.edge = server
	n.mu.Lock()
	n.edgeState = "running"
	n.mu.Unlock()
	go n.serveEdge(tracked)

	if config.seams.NewAnnouncer != nil {
		announcer, err := config.seams.NewAnnouncer(AnnouncerConfig{
			PublicKey: config.identity.PublicKey(), Port: uint16(n.port), Logf: config.logger.Logf("debug"),
		})
		n.mu.Lock()
		if err != nil {
			n.mdnsState = "failed"
			config.logger.Warn("local network announcement failed", logx.Fields{"error": err.Error()})
		} else {
			n.announcer = announcer
			n.mdnsState = "announcing"
		}
		n.mu.Unlock()
	}
	config.onChange()
	return n, nil
}

// listenDirect binds the preferred UDP port and falls back to a free one.
func listenDirect(host string, preferred int) (net.PacketConn, error) {
	if preferred <= 0 {
		preferred = DefaultDirectPort
	}
	packetConn, err := net.ListenPacket("udp", net.JoinHostPort(host, strconv.Itoa(preferred)))
	if err == nil {
		return packetConn, nil
	}
	fallback, fallbackErr := net.ListenPacket("udp", net.JoinHostPort(host, "0"))
	if fallbackErr != nil {
		return nil, errors.Join(err, fallbackErr)
	}
	return fallback, nil
}

func udpPort(address net.Addr) int {
	if udp, ok := address.(*net.UDPAddr); ok {
		return udp.Port
	}
	return 0
}

func (n *network) newPortMapper() candidates.PortMapper {
	factory := n.config.seams.NewPortMapper
	if factory == nil {
		factory = func(port uint16, logf func(string, ...any)) (candidates.PortMapper, error) {
			return portmap.New(port, logf)
		}
	}
	mapper, err := factory(uint16(n.port), n.config.logger.Logf("debug"))
	if err != nil {
		n.config.logger.Warn("gateway port mapping unavailable", logx.Fields{"error": err.Error()})
		return nil
	}
	return mapper
}

// startTor starts the onion service and its listener. Any failure leaves
// Tor failed while the direct path keeps working.
func (n *network) startTor() {
	start := n.config.seams.StartTor
	if start == nil {
		start = func(config tor.DesktopConfig) (TorService, error) { return tor.StartDesktop(config) }
	}
	n.torLog = &lineLogger{logger: n.config.logger}
	service, err := start(tor.DesktopConfig{
		Executable: n.config.torExecutable, Dir: n.config.paths.Tor, OnionKeyPath: n.config.paths.OnionKey,
		Output: n.torLog, OnState: n.torChanged,
	})
	if err != nil {
		n.config.logger.Warn("tor did not start", logx.Fields{"error": err.Error()})
		n.setTorState(TorStatus{State: torFailed, Onion: n.onionAddress, Error: "tor_unavailable"})
		return
	}
	listener, err := onion.Listen(service.Listener(), n.config.identity, onion.ListenConfig{Registry: n.config.devices, Pairing: n.config.sessions})
	if err != nil {
		n.config.logger.Warn("onion listener did not start", logx.Fields{"error": err.Error()})
		_ = service.Close()
		n.setTorState(TorStatus{State: torFailed, Onion: n.onionAddress, Error: "tor_listener"})
		return
	}
	n.tor = service
	n.onion = listener
	// StartDesktop returns before the supervisor reports its first phase;
	// the snapshot fills the status unless a callback already did.
	initial := torStatus(service.State())
	if initial.Onion == "" {
		initial.Onion = n.onionAddress
	}
	n.mu.Lock()
	pending := n.torState.State == torDisabled
	if pending {
		n.torState = initial
	}
	n.mu.Unlock()
	if pending {
		n.config.onTorState(initial)
	}
}

// torChanged receives every snapshot of the supervisor, serially.
func (n *network) torChanged(state tor.State) {
	n.mu.Lock()
	stopped := n.stopped
	n.mu.Unlock()
	if stopped && state.Phase != tor.PhaseStopped {
		return
	}
	status := torStatus(state)
	if status.Onion == "" {
		status.Onion = n.onionAddress
	}
	n.setTorState(status)
}

func (n *network) setTorState(status TorStatus) {
	n.mu.Lock()
	changed := n.torState != status
	n.torState = status
	n.mu.Unlock()
	if changed {
		n.config.onTorState(status)
		n.config.onChange()
	}
}

func (n *network) serveEdge(listener transport.Listener) {
	defer close(n.edgeDone)
	err := n.edge.Serve(listener)
	n.mu.Lock()
	stopped := n.stopped
	if !stopped {
		n.edgeState = "failed"
		if err == nil {
			err = errors.New("edge stopped")
		}
	}
	n.mu.Unlock()
	if !stopped {
		n.config.logger.Error("edge server stopped", logx.Fields{"error": err.Error()})
		n.config.onChange()
	}
}

// reach is the reach card the edge returns at the end of pairing.
func (n *network) reach() edge.ReachCard {
	list := n.collector.Snapshot().Pairing()
	if len(list) > candidates.MaxCardCandidates {
		list = list[:candidates.MaxCardCandidates]
	}
	return edge.ReachCard{Onion: n.qrOnion(), Candidates: list}
}

// qrOnion is the onion host with the virtual port, as the QR carries it.
func (n *network) qrOnion() string {
	return net.JoinHostPort(n.onionAddress, strconv.Itoa(tor.OnionPort))
}

// candidatesChanged runs on the collector notify loop, in order.
func (n *network) candidatesChanged(candidates.Snapshot) {
	n.firstOnce.Do(func() { close(n.first) })
	n.mu.Lock()
	peers := make([]*controlPeer, 0, len(n.controls))
	for peer := range n.controls {
		peers = append(peers, peer)
	}
	n.mu.Unlock()
	for _, peer := range peers {
		peer.kick()
	}
	n.config.onChange()
}

// waitCandidates waits, at most limit, for the first candidate snapshot, so a
// QR generated right after net.start already lists the local addresses.
func (n *network) waitCandidates(ctx context.Context, limit time.Duration) candidates.Snapshot {
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-n.first:
	case <-timer.C:
	case <-ctx.Done():
	}
	return n.collector.Snapshot()
}

func (n *network) currentDesktop() pairing.Desktop {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.desktop
}

// apply changes the name and the approval of a running network.
func (n *network) apply(name string, requireApproval bool) {
	n.mu.Lock()
	renamed := n.desktop.Name != name
	n.desktop.Name = name
	n.mu.Unlock()
	if n.edge != nil {
		_ = n.edge.SetDesktopName(name)
		n.edge.SetRequireApproval(requireApproval)
	}
	if renamed {
		n.mu.Lock()
		peers := make([]*controlPeer, 0, len(n.controls))
		for peer := range n.controls {
			peers = append(peers, peer)
		}
		n.mu.Unlock()
		for _, peer := range peers {
			peer.kick()
		}
	}
	n.config.onChange()
}

func (n *network) reannounce() {
	if n.announcer == nil {
		return
	}
	err := n.announcer.Refresh()
	n.mu.Lock()
	if err != nil {
		n.mdnsState = "failed"
	} else {
		n.mdnsState = "announcing"
	}
	n.mu.Unlock()
	if err != nil {
		n.config.logger.Warn("local network announcement failed", logx.Fields{"error": err.Error()})
	}
}

// refresh collects the candidates again, which also renews the mapping and
// runs STUN when there is no mapping, and republishes the announcement.
func (n *network) refresh(ctx context.Context) {
	if n.collector != nil {
		collectCtx, cancel := context.WithTimeout(ctx, candidates.DefaultSTUNTimeout+time.Second)
		_, _ = n.collector.Collect(collectCtx)
		cancel()
	}
	n.reannounce()
	n.config.onChange()
}

// status reports the run; runtime.status adds the desktop and the last error.
func (n *network) status() NetStatus {
	status := stoppedStatus()
	n.mu.Lock()
	status.Edge.State = n.edgeState
	status.Tor = n.torState
	status.MDNS.State = n.mdnsState
	status.Sessions = n.counts
	stunConfigured := len(n.config.stunServers) > 0
	n.mu.Unlock()
	if n.direct == nil {
		status.Direct.State = "failed"
		return status
	}
	status.Direct.State = "listening"
	status.Direct.Port = n.port
	if n.collector != nil {
		snapshot := n.collector.Snapshot()
		status.Direct.Candidates = directCandidates(snapshot)
		if snapshot.Mapping.Valid(time.Now()) {
			status.Direct.Mapping = MappingStatus{Protocol: mappingProtocol(snapshot.Mapping.Protocol), External: snapshot.Mapping.External.String()}
		}
		status.Direct.STUN = stunStatus(stunConfigured, snapshot)
	}
	return status
}

// stunStatus is ok when an address was reflected or when a gateway mapping
// made STUN unnecessary, and failed when STUN is enabled without either.
func stunStatus(configured bool, snapshot candidates.Snapshot) STUNStatus {
	if !configured {
		return STUNStatus{State: "disabled"}
	}
	for _, candidate := range snapshot.Candidates {
		if candidate.Type == pairing.CandidateSTUN {
			return STUNStatus{State: "ok", Addr: candidate.Address.String()}
		}
	}
	if snapshot.Mapping.Valid(time.Now()) {
		return STUNStatus{State: "ok"}
	}
	return STUNStatus{State: "failed"}
}

// sessionOpened counts one accepted transport session until it ends and
// accepts the control channel of direct sessions.
func (n *network) sessionOpened(session transport.Session) {
	key, name := session.PeerKey(), session.Transport()
	n.mu.Lock()
	if n.stopped {
		n.mu.Unlock()
		_ = session.Close()
		return
	}
	n.adjustLocked(key, name, 1)
	n.mu.Unlock()
	n.config.onChange()
	go func() {
		<-session.Done()
		n.mu.Lock()
		n.adjustLocked(key, name, -1)
		n.mu.Unlock()
		n.config.onChange()
	}()
	if control, ok := session.(transport.ControlSession); ok && name == transport.NameDirect {
		go n.acceptControl(control)
	}
}

func (n *network) adjustLocked(key, name string, delta int) {
	byTransport := n.live[key]
	if byTransport == nil {
		byTransport = make(map[string]int)
		n.live[key] = byTransport
	}
	byTransport[name] += delta
	if byTransport[name] <= 0 {
		delete(byTransport, name)
	}
	if len(byTransport) == 0 {
		delete(n.live, key)
	}
	switch name {
	case transport.NameDirect:
		n.counts.Direct += delta
	case transport.NameTor:
		n.counts.Tor += delta
	}
}

// transportsOf lists the transports with a live session of key.
func (n *network) transportsOf(key string) []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	names := make([]string, 0, len(n.live[key]))
	for name := range n.live[key] {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// acceptControl waits for the control stream of a direct session. Restricted
// sessions never get one and end the wait when they close.
func (n *network) acceptControl(session transport.ControlSession) {
	conn, err := rendezvous.Accept(n.ctx, session, rendezvous.Config{
		Role: identity.RoleDesktop, LocalKey: n.config.identity.PublicKeyString(), Puncher: n.endpoint,
		Handler: rendezvous.Handler{
			PathReport: func(report rendezvous.PathReport) { n.pathReport(session, report) },
			PunchServed: func(result rendezvous.PunchResult) {
				fields := logx.Fields{"candidates": len(result.Candidates), "sent": result.Report.Sent, "acknowledged": len(result.Report.Acknowledged), "ms": result.Duration.Milliseconds()}
				if result.Err != nil {
					fields["error"] = result.Err.Error()
				}
				n.config.logger.Info("punch served", fields)
			},
		},
		Logf: n.config.logger.Logf("debug"),
	})
	if err != nil {
		return
	}
	peer := &controlPeer{network: n, conn: conn, wake: make(chan struct{}, 1)}
	n.mu.Lock()
	if n.stopped {
		n.mu.Unlock()
		_ = conn.Close()
		return
	}
	n.controls[peer] = struct{}{}
	n.mu.Unlock()
	peer.kick()
	peer.run()
	n.mu.Lock()
	delete(n.controls, peer)
	n.mu.Unlock()
}

func (n *network) pathReport(session transport.Session, report rendezvous.PathReport) {
	deviceID, _ := n.config.devices.RegisteredKey(session.PeerKey())
	n.config.onEvent("path.changed", map[string]any{
		"deviceId": deviceID, "transport": session.Transport(), "path": report.Path,
		"address": report.Address, "rttMs": report.RTTMillis, "reason": report.Reason,
	})
}

// controlPeer keeps one control channel current: the latest candidates and
// reach card are sent after hello, on every change and before the TTL ends.
type controlPeer struct {
	network *network
	conn    *rendezvous.Conn
	wake    chan struct{}
}

func (peer *controlPeer) kick() {
	select {
	case peer.wake <- struct{}{}:
	default:
	}
}

func (peer *controlPeer) run() {
	ticker := time.NewTicker(controlResend)
	defer ticker.Stop()
	for {
		select {
		case <-peer.wake:
		case <-ticker.C:
		case <-peer.conn.Done():
			return
		case <-peer.network.ctx.Done():
			_ = peer.conn.Close()
			return
		}
		peer.send()
	}
}

func (peer *controlPeer) send() {
	n := peer.network
	ctx, cancel := context.WithTimeout(n.ctx, controlSendTimeout)
	defer cancel()
	list := n.collector.Snapshot().Pairing()
	sent, err := peer.conn.SendCandidates(ctx, list, controlCandidateTTL)
	if err != nil {
		n.config.logger.Debug("control candidates not sent", logx.Fields{"error": err.Error()})
		return
	}
	card, err := candidates.NewCard(n.currentDesktop(), n.qrOnion(), sent.Candidates, time.Now(), 0)
	if err != nil {
		n.config.logger.Debug("reach card not built", logx.Fields{"error": err.Error()})
		return
	}
	if err := peer.conn.SendReachUpdate(ctx, card); err != nil {
		n.config.logger.Debug("reach card not sent", logx.Fields{"error": err.Error()})
	}
}

// close stops the run in the order of net.stop: edge, listeners, mDNS,
// mapping and Tor. It waits for Tor to exit.
func (n *network) close() {
	n.mu.Lock()
	if n.stopped {
		n.mu.Unlock()
		return
	}
	n.stopped = true
	n.mu.Unlock()
	n.cancel()
	if n.edge != nil {
		ctx, cancel := context.WithTimeout(context.Background(), edgeCloseTimeout)
		if err := n.edge.Close(ctx); err != nil {
			n.config.logger.Warn("edge did not close cleanly", logx.Fields{"error": err.Error()})
		}
		cancel()
		<-n.edgeDone
	} else {
		if n.direct != nil {
			_ = n.direct.Close()
		}
		if n.onion != nil {
			_ = n.onion.Close()
		}
	}
	if n.endpoint != nil {
		_ = n.endpoint.Close()
	}
	if n.announcer != nil {
		if err := n.announcer.Close(); err != nil {
			n.config.logger.Warn("local network announcement not withdrawn", logx.Fields{"error": err.Error()})
		}
	}
	if n.collector != nil {
		if err := n.collector.Close(); err != nil {
			n.config.logger.Warn("gateway mapping not released", logx.Fields{"error": err.Error()})
		}
	} else if n.mapper != nil {
		_ = n.mapper.Close()
	}
	if n.tor != nil {
		if err := n.tor.Close(); err != nil {
			n.config.logger.Warn("tor did not stop cleanly", logx.Fields{"error": err.Error()})
		}
	}
	if n.torLog != nil {
		n.torLog.flush()
	}
	n.mu.Lock()
	n.edgeState = "stopped"
	n.mdnsState = "disabled"
	n.torState = TorStatus{State: torDisabled, Onion: n.onionAddress}
	n.counts = SessionCounts{}
	n.live = make(map[string]map[string]int)
	n.mu.Unlock()
}

// trackingListener reports every accepted session to the network before the
// edge serves it; the rest of transport.Listener passes through.
type trackingListener struct {
	transport.Listener
	network *network
}

func (listener *trackingListener) Accept(ctx context.Context) (transport.Session, error) {
	session, err := listener.Listener.Accept(ctx)
	if err != nil {
		return nil, err
	}
	listener.network.sessionOpened(session)
	return session, nil
}

// lineLogger turns the notice log Tor writes on stdout into log entries.
type lineLogger struct {
	logger *logx.Logger
	mu     sync.Mutex
	buffer []byte
}

const maxTorLogLine = 4096

func (writer *lineLogger) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.buffer = append(writer.buffer, data...)
	for {
		index := slices.Index(writer.buffer, '\n')
		if index < 0 {
			break
		}
		writer.log(writer.buffer[:index])
		writer.buffer = writer.buffer[index+1:]
	}
	if len(writer.buffer) > maxTorLogLine {
		writer.log(writer.buffer)
		writer.buffer = nil
	}
	return len(data), nil
}

func (writer *lineLogger) log(line []byte) {
	if len(line) == 0 {
		return
	}
	writer.logger.Info("tor", logx.Fields{"line": string(line)})
}

func (writer *lineLogger) flush() {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.log(writer.buffer)
	writer.buffer = nil
}

var (
	_ io.Writer  = (*lineLogger)(nil)
	_ TorService = (*tor.Desktop)(nil)
)
