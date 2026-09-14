// SPDX-License-Identifier: Apache-2.0

package rendezvous

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"tailscale.com/net/netmon"
	"tailscale.com/net/portmapper"
	"tailscale.com/net/portmapper/portmappertype"
	"tailscale.com/net/stun"
	"tailscale.com/types/logger"
	"tailscale.com/util/eventbus"
)

const (
	punchRequestPrefix = "\x00CIALAI-RENDEZVOUS-PUNCH/1 "
	punchReplyPrefix   = "\x00CIALAI-RENDEZVOUS-PUNCH-ACK/1 "
)

type ProtocolProbe struct {
	PCP  bool `json:"pcp"`
	PMP  bool `json:"natPmp"`
	UPnP bool `json:"upnp"`
}

type STUNProbe struct {
	Server        string `json:"server"`
	ReflexiveAddr string `json:"reflexiveAddress,omitempty"`
	RTTMillis     int64  `json:"rttMillis,omitempty"`
	Error         string `json:"error,omitempty"`
}

type NetworkProbe struct {
	Protocols    ProtocolProbe `json:"mappingProtocols"`
	Mapping      string        `json:"mappingAddress,omitempty"`
	MappingType  string        `json:"mappingType,omitempty"`
	MappingError string        `json:"mappingError,omitempty"`
	STUN         []STUNProbe   `json:"stun,omitempty"`
	CollectionMS int64         `json:"collectionMillis"`
}

type QUICDirectConfig struct {
	PacketConn        net.PacketConn
	PublicKey         string
	ClientTLS         *tls.Config
	ServerTLS         *tls.Config
	QUIC              *quic.Config
	STUNServers       []string
	IncludeLoopback   bool
	CollectionTimeout time.Duration
}

// QUICDirectTransport is the real DirectTransport adapter used by CON-012.
// It deliberately owns exactly one packet socket and one quic.Transport.
type QUICDirectTransport struct {
	packetConn      net.PacketConn
	transport       *quic.Transport
	listener        *quic.Listener
	clientTLS       *tls.Config
	quicConfig      *quic.Config
	publicKey       string
	stunServers     []string
	includeLoopback bool
	collectTimeout  time.Duration
	mux             *packetMux
	cancel          context.CancelFunc

	mu       sync.Mutex
	mappings []*mappingRuntime
	probe    NetworkProbe
	closed   bool
}

func NewQUICDirectTransport(parent context.Context, config QUICDirectConfig) (*QUICDirectTransport, error) {
	if config.PacketConn == nil {
		return nil, errors.New("QUIC packet connection is required")
	}
	if err := validatePublicKey(config.PublicKey); err != nil {
		return nil, fmt.Errorf("QUIC public key: %w", err)
	}
	if config.ClientTLS == nil && config.ServerTLS == nil {
		return nil, errors.New("client or server QUIC TLS config is required")
	}
	if config.CollectionTimeout <= 0 {
		config.CollectionTimeout = 6 * time.Second
	}
	if config.QUIC == nil {
		config.QUIC = defaultQUICConfig()
	}
	ctx, cancel := context.WithCancel(parent)
	transport := &quic.Transport{Conn: config.PacketConn}
	direct := &QUICDirectTransport{
		packetConn: config.PacketConn, transport: transport, clientTLS: config.ClientTLS,
		quicConfig: config.QUIC, publicKey: config.PublicKey,
		stunServers:     append([]string(nil), config.STUNServers...),
		includeLoopback: config.IncludeLoopback, collectTimeout: config.CollectionTimeout,
		cancel: cancel,
	}
	direct.mux = newPacketMux(transport)
	go direct.mux.run(ctx)
	if config.ServerTLS != nil {
		listener, err := transport.Listen(config.ServerTLS.Clone(), config.QUIC.Clone())
		if err != nil {
			cancel()
			_ = transport.Close()
			_ = config.PacketConn.Close()
			return nil, fmt.Errorf("listen QUIC rendezvous: %w", err)
		}
		direct.listener = listener
	}
	return direct, nil
}

func (direct *QUICDirectTransport) Offer(ctx context.Context, role string) (Offer, error) {
	if role != "client" && role != "server" {
		return Offer{}, fmt.Errorf("unsupported QUIC offer role %q", role)
	}
	port, err := packetPort(direct.packetConn.LocalAddr())
	if err != nil {
		return Offer{}, err
	}
	candidates, err := localCandidates(port, direct.includeLoopback)
	if err != nil {
		return Offer{}, err
	}
	collectionContext, cancel := context.WithTimeout(ctx, direct.collectTimeout)
	probe, mapping := collectNetwork(collectionContext, direct.mux, uint16(port), direct.stunServers)
	cancel()
	if mapping != nil {
		direct.mu.Lock()
		direct.mappings = append(direct.mappings, mapping)
		direct.mu.Unlock()
	}
	for _, candidate := range candidatesFromProbe(probe) {
		candidates = appendCandidate(candidates, candidate)
	}
	if len(candidates) == 0 {
		return Offer{}, errors.New("no usable direct candidate found")
	}
	direct.mu.Lock()
	direct.probe = probe
	direct.mu.Unlock()
	return Offer{Role: role, PublicKey: direct.publicKey, Candidates: candidates}, nil
}

func (direct *QUICDirectTransport) Punch(ctx context.Context, candidates []Candidate) (PunchReport, error) {
	report := PunchReport{}
	for _, candidate := range candidates {
		remote, err := net.ResolveUDPAddr("udp", candidate.Address)
		if err != nil {
			continue
		}
		report.Sent++
		attemptContext, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		if direct.mux.punch(attemptContext, remote) {
			report.Acknowledged++
		}
		cancel()
	}
	if report.Sent == 0 {
		return report, errors.New("no valid candidate could receive a punch packet")
	}
	return report, nil
}

func (direct *QUICDirectTransport) Dial(ctx context.Context, candidates []Candidate) (DirectConnection, error) {
	if direct.clientTLS == nil {
		return nil, errors.New("QUIC client TLS config is not configured")
	}
	type result struct {
		connection *quic.Conn
		candidate  Candidate
		err        error
	}
	dialContext, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan result, len(candidates))
	for _, candidate := range candidates {
		candidate := candidate
		go func() {
			remote, err := net.ResolveUDPAddr("udp", candidate.Address)
			if err != nil {
				results <- result{candidate: candidate, err: err}
				return
			}
			connection, err := direct.transport.Dial(dialContext, remote, direct.clientTLS.Clone(), direct.quicConfig.Clone())
			results <- result{connection: connection, candidate: candidate, err: err}
		}()
	}
	var failures []error
	for range candidates {
		result := <-results
		if result.err == nil {
			cancel()
			return &quicDirectConnection{connection: result.connection, candidate: result.candidate}, nil
		}
		failures = append(failures, fmt.Errorf("%s %s: %w", result.candidate.Type, result.candidate.Address, result.err))
	}
	if len(failures) == 0 {
		return nil, errors.New("no QUIC candidate to dial")
	}
	return nil, errors.Join(failures...)
}

func (direct *QUICDirectTransport) Accept(ctx context.Context) (DirectConnection, error) {
	if direct.listener == nil {
		return nil, errors.New("QUIC server listener is not configured")
	}
	connection, err := direct.listener.Accept(ctx)
	if err != nil {
		return nil, fmt.Errorf("accept QUIC rendezvous connection: %w", err)
	}
	candidate, err := observedCandidate(connection.RemoteAddr())
	if err != nil {
		_ = connection.CloseWithError(1, "invalid remote address")
		return nil, err
	}
	return &quicDirectConnection{connection: connection, candidate: candidate}, nil
}

func (direct *QUICDirectTransport) Probe() NetworkProbe {
	direct.mu.Lock()
	defer direct.mu.Unlock()
	return direct.probe
}

func (direct *QUICDirectTransport) Close() error {
	direct.mu.Lock()
	if direct.closed {
		direct.mu.Unlock()
		return nil
	}
	direct.closed = true
	mappings := append([]*mappingRuntime(nil), direct.mappings...)
	direct.mu.Unlock()
	direct.cancel()
	for _, mapping := range mappings {
		mapping.close()
	}
	if direct.listener != nil {
		_ = direct.listener.Close()
	}
	transportErr := direct.transport.Close()
	packetErr := direct.packetConn.Close()
	return errors.Join(transportErr, packetErr)
}

type quicDirectConnection struct {
	connection *quic.Conn
	candidate  Candidate
}

func (connection *quicDirectConnection) Candidate() Candidate { return connection.candidate }

func (connection *quicDirectConnection) Close() error {
	return connection.connection.CloseWithError(0, "rendezvous measurement complete")
}

func defaultQUICConfig() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout: 5 * time.Second,
		MaxIdleTimeout:       15 * time.Second,
		KeepAlivePeriod:      5 * time.Second,
		Allow0RTT:            false,
	}
}

func packetPort(address net.Addr) (int, error) {
	udp, ok := address.(*net.UDPAddr)
	if !ok || udp.Port < 1 || udp.Port > 65535 {
		return 0, fmt.Errorf("unexpected UDP address %q", address)
	}
	return udp.Port, nil
}

func localCandidates(port int, includeLoopback bool) ([]Candidate, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list interfaces: %w", err)
	}
	seen := make(map[string]bool)
	var result []Candidate
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, raw := range addresses {
			prefix, err := netip.ParsePrefix(raw.String())
			if err != nil {
				continue
			}
			ip := prefix.Addr().Unmap()
			if !ip.IsValid() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip.IsLoopback() && !includeLoopback {
				continue
			}
			kind := ""
			switch {
			case ip.Is4() && (ip.IsPrivate() || ip.IsLoopback()):
				kind = "lan"
			case ip.Is6() && ip.IsGlobalUnicast() && !ip.IsPrivate():
				kind = "ipv6"
			}
			if kind == "" {
				continue
			}
			address := netip.AddrPortFrom(ip, uint16(port)).String()
			if !seen[address] {
				seen[address] = true
				result = append(result, Candidate{Type: kind, Address: address})
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Type != result[j].Type {
			return result[i].Type < result[j].Type
		}
		return result[i].Address < result[j].Address
	})
	return result, nil
}

func appendCandidate(candidates []Candidate, item Candidate) []Candidate {
	for _, existing := range candidates {
		if existing.Address == item.Address {
			return candidates
		}
	}
	return append(candidates, item)
}

func observedCandidate(address net.Addr) (Candidate, error) {
	parsed, err := netip.ParseAddrPort(address.String())
	if err != nil {
		return Candidate{}, fmt.Errorf("parse observed QUIC address %q: %w", address, err)
	}
	kind := "stun"
	if parsed.Addr().IsLoopback() || parsed.Addr().IsPrivate() {
		kind = "lan"
	} else if parsed.Addr().Is6() {
		kind = "ipv6"
	}
	return Candidate{Type: kind, Address: parsed.String(), Protocol: "observed"}, nil
}

type stunReply struct {
	address string
	rtt     time.Duration
	err     error
}

type packetMux struct {
	transport    *quic.Transport
	mu           sync.Mutex
	stunWaiting  map[stun.TxID]chan stunReply
	punchWaiting map[string]chan struct{}
}

func newPacketMux(transport *quic.Transport) *packetMux {
	return &packetMux{
		transport: transport, stunWaiting: make(map[stun.TxID]chan stunReply),
		punchWaiting: make(map[string]chan struct{}),
	}
}

func (mux *packetMux) run(ctx context.Context) {
	buffer := make([]byte, 64*1024)
	for {
		n, remote, err := mux.transport.ReadNonQUICPacket(ctx, buffer)
		if err != nil {
			return
		}
		packet := append([]byte(nil), buffer[:n]...)
		if transactionID, address, err := stun.ParseResponse(packet); err == nil {
			mux.mu.Lock()
			waiting := mux.stunWaiting[transactionID]
			delete(mux.stunWaiting, transactionID)
			mux.mu.Unlock()
			if waiting != nil {
				waiting <- stunReply{address: address.String()}
			}
			continue
		}
		text := string(packet)
		switch {
		case strings.HasPrefix(text, punchRequestPrefix):
			nonce := strings.TrimSpace(strings.TrimPrefix(text, punchRequestPrefix))
			if nonce != "" {
				_, _ = mux.transport.WriteTo([]byte(punchReplyPrefix+nonce), remote)
			}
		case strings.HasPrefix(text, punchReplyPrefix):
			nonce := strings.TrimSpace(strings.TrimPrefix(text, punchReplyPrefix))
			mux.mu.Lock()
			waiting := mux.punchWaiting[nonce]
			delete(mux.punchWaiting, nonce)
			mux.mu.Unlock()
			if waiting != nil {
				close(waiting)
			}
		}
	}
}

func (mux *packetMux) stun(ctx context.Context, server string) stunReply {
	remote, err := net.ResolveUDPAddr("udp", server)
	if err != nil {
		return stunReply{err: err}
	}
	transactionID := stun.NewTxID()
	waiting := make(chan stunReply, 1)
	mux.mu.Lock()
	mux.stunWaiting[transactionID] = waiting
	mux.mu.Unlock()
	started := time.Now()
	if _, err := mux.transport.WriteTo(stun.Request(transactionID), remote); err != nil {
		mux.removeSTUNWaiter(transactionID)
		return stunReply{err: err}
	}
	select {
	case reply := <-waiting:
		reply.rtt = time.Since(started)
		return reply
	case <-ctx.Done():
		mux.removeSTUNWaiter(transactionID)
		return stunReply{err: ctx.Err()}
	}
}

func (mux *packetMux) removeSTUNWaiter(transactionID stun.TxID) {
	mux.mu.Lock()
	delete(mux.stunWaiting, transactionID)
	mux.mu.Unlock()
}

func (mux *packetMux) punch(ctx context.Context, remote net.Addr) bool {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return false
	}
	nonce := base64.RawURLEncoding.EncodeToString(random)
	waiting := make(chan struct{})
	mux.mu.Lock()
	mux.punchWaiting[nonce] = waiting
	mux.mu.Unlock()
	if _, err := mux.transport.WriteTo([]byte(punchRequestPrefix+nonce), remote); err != nil {
		mux.removePunchWaiter(nonce)
		return false
	}
	select {
	case <-waiting:
		return true
	case <-ctx.Done():
		mux.removePunchWaiter(nonce)
		return false
	}
}

func (mux *packetMux) removePunchWaiter(nonce string) {
	mux.mu.Lock()
	delete(mux.punchWaiting, nonce)
	mux.mu.Unlock()
}

type mappingRuntime struct {
	bus        *eventbus.Bus
	monitor    *netmon.Monitor
	client     *portmapper.Client
	subscriber *eventbus.Subscriber[portmappertype.Mapping]
	subClient  *eventbus.Client
}

func (runtime *mappingRuntime) close() {
	if runtime == nil {
		return
	}
	if runtime.subscriber != nil {
		runtime.subscriber.Close()
	}
	if runtime.subClient != nil {
		runtime.subClient.Close()
	}
	if runtime.client != nil {
		_ = runtime.client.Close()
	}
	if runtime.monitor != nil {
		_ = runtime.monitor.Close()
	}
	if runtime.bus != nil {
		runtime.bus.Close()
	}
}

func collectNetwork(ctx context.Context, mux *packetMux, localPort uint16, stunServers []string) (NetworkProbe, *mappingRuntime) {
	started := time.Now()
	probe := NetworkProbe{}
	var mapping portmappertype.Mapping
	var mappingErr error
	var protocols ProtocolProbe
	var runtime *mappingRuntime
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		mapping, protocols, runtime, mappingErr = collectMapping(ctx, localPort)
	}()
	probe.STUN = make([]STUNProbe, len(stunServers))
	for index, server := range stunServers {
		index, server := index, server
		wait.Add(1)
		go func() {
			defer wait.Done()
			requestContext, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			reply := mux.stun(requestContext, server)
			result := STUNProbe{Server: server}
			if reply.err != nil {
				result.Error = reply.err.Error()
			} else {
				result.ReflexiveAddr = reply.address
				result.RTTMillis = reply.rtt.Milliseconds()
			}
			probe.STUN[index] = result
		}()
	}
	wait.Wait()
	probe.Protocols = protocols
	if mapping.External.IsValid() {
		probe.Mapping = mapping.External.String()
		probe.MappingType = mapping.Type
	}
	if mappingErr != nil {
		probe.MappingError = mappingErr.Error()
	}
	probe.CollectionMS = time.Since(started).Milliseconds()
	return probe, runtime
}

func collectMapping(ctx context.Context, localPort uint16) (portmappertype.Mapping, ProtocolProbe, *mappingRuntime, error) {
	bus := eventbus.New()
	monitor, err := netmon.New(bus, logger.Discard)
	if err != nil {
		bus.Close()
		return portmappertype.Mapping{}, ProtocolProbe{}, nil, fmt.Errorf("start network monitor: %w", err)
	}
	monitor.Start()
	subClient := bus.Client("rendezvous-spike")
	subscriber := eventbus.Subscribe[portmappertype.Mapping](subClient)
	client := portmapper.NewClient(portmapper.Config{EventBus: bus, Logf: logger.Discard, NetMon: monitor})
	client.SetGatewayLookupFunc(monitor.GatewayAndSelfIP)
	client.SetLocalPort(localPort)
	runtime := &mappingRuntime{bus: bus, monitor: monitor, client: client, subscriber: subscriber, subClient: subClient}
	available, probeErr := client.Probe(ctx)
	protocols := ProtocolProbe{PCP: available.PCP, PMP: available.PMP, UPnP: available.UPnP}
	if probeErr != nil {
		return portmappertype.Mapping{}, protocols, runtime, fmt.Errorf("probe port mapping: %w", probeErr)
	}
	if !available.PCP && !available.PMP && !available.UPnP {
		return portmappertype.Mapping{}, protocols, runtime, errors.New("no PCP, NAT-PMP or UPnP service discovered")
	}
	if external, ok := client.GetCachedMappingOrStartCreatingOne(); ok {
		return portmappertype.Mapping{External: external, Type: inferMappingType(protocols)}, protocols, runtime, nil
	}
	select {
	case mapping := <-subscriber.Events():
		return mapping, protocols, runtime, nil
	case <-ctx.Done():
		return portmappertype.Mapping{}, protocols, runtime, fmt.Errorf("create port mapping: %w", ctx.Err())
	}
}

func inferMappingType(protocols ProtocolProbe) string {
	var names []string
	if protocols.PCP {
		names = append(names, "pcp")
	}
	if protocols.PMP {
		names = append(names, "nat-pmp")
	}
	if protocols.UPnP {
		names = append(names, "upnp")
	}
	if len(names) == 1 {
		return names[0]
	}
	return "cached-or-unknown"
}

func candidatesFromProbe(probe NetworkProbe) []Candidate {
	var result []Candidate
	if probe.Mapping != "" {
		result = append(result, Candidate{Type: "mapped", Address: probe.Mapping, Protocol: probe.MappingType})
	}
	for _, item := range probe.STUN {
		if item.ReflexiveAddr == "" {
			continue
		}
		if parsed, err := netip.ParseAddrPort(item.ReflexiveAddr); err == nil && parsed.Port() != 0 {
			result = appendCandidate(result, Candidate{Type: "stun", Address: parsed.String(), Protocol: item.Server})
		}
	}
	return result
}
