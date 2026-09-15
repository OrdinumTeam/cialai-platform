// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"tailscale.com/net/stun"
)

// DefaultSTUNServers are the public STUN servers the desktop sidecar and the
// phone ask through their QUIC socket when no gateway mapping exists.
var DefaultSTUNServers = []string{"stun.cloudflare.com:3478", "stun.l.google.com:19302"}

// STUN retransmits follow RFC 8489: the request goes out again after 500 ms
// and then after twice the previous interval, until the round deadline.
const stunInitialRetransmit = 500 * time.Millisecond

type stunWaiter struct {
	remote  netip.AddrPort
	replies chan netip.AddrPort
}

type stunClient struct {
	socket   Socket
	servers  []string
	timeout  time.Duration
	ipv6     bool
	resolver *net.Resolver
	logf     func(format string, args ...any)

	mu      sync.Mutex
	waiting map[stun.TxID]stunWaiter
}

func newSTUNClient(socket Socket, servers []string, timeout time.Duration, ipv6 bool, logf func(string, ...any)) *stunClient {
	return &stunClient{
		socket:   socket,
		servers:  slices.Clone(servers),
		timeout:  timeout,
		ipv6:     ipv6,
		resolver: net.DefaultResolver,
		logf:     logf,
		waiting:  make(map[stun.TxID]stunWaiter),
	}
}

func validSTUNServer(server string) error {
	host, portText, err := net.SplitHostPort(server)
	if err != nil {
		return fmt.Errorf("STUN server %q: %w", server, err)
	}
	port, err := strconv.Atoi(portText)
	if host == "" || err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("STUN server %q must be host:port", server)
	}
	return nil
}

// handle receives every non-QUIC datagram of the shared socket. It must not
// block the packet loop, so a reply is dropped when one is already queued.
func (client *stunClient) handle(packet []byte, from net.Addr) {
	if !stun.Is(packet) {
		return
	}
	txID, reflected, err := stun.ParseResponse(packet)
	if err != nil {
		return
	}
	source := addrPortOf(from)
	client.mu.Lock()
	waiter, ok := client.waiting[txID]
	if ok && waiter.remote == source {
		delete(client.waiting, txID)
	}
	client.mu.Unlock()
	if !ok || waiter.remote != source {
		return
	}
	select {
	case waiter.replies <- reflected:
	default:
	}
}

// query asks every server at once and returns the public reflected addresses
// in server order, all within client.timeout.
func (client *stunClient) query(ctx context.Context) []Candidate {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	answers := make([][]Candidate, len(client.servers))
	var wait sync.WaitGroup
	for index, server := range client.servers {
		wait.Go(func() { answers[index] = client.queryServer(ctx, server) })
	}
	wait.Wait()
	var result []Candidate
	for _, list := range answers {
		result = append(result, list...)
	}
	return result
}

// queryServer asks the first IPv4 and, on a dual-stack socket, the first IPv6
// address of server.
func (client *stunClient) queryServer(ctx context.Context, server string) []Candidate {
	host, portText, _ := net.SplitHostPort(server)
	port, _ := strconv.Atoi(portText)
	addresses, err := client.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		client.logf("candidates: resolve STUN server %s: %v", server, err)
		return nil
	}
	var targets []netip.AddrPort
	var haveIPv4, haveIPv6 bool
	for _, address := range addresses {
		address = address.Unmap()
		switch {
		case address.Is4() && !haveIPv4:
			haveIPv4 = true
		case address.Is6() && !haveIPv6 && client.ipv6:
			haveIPv6 = true
		default:
			continue
		}
		targets = append(targets, netip.AddrPortFrom(address, uint16(port)))
	}
	replies := make([]netip.AddrPort, len(targets))
	var wait sync.WaitGroup
	for index, target := range targets {
		wait.Go(func() {
			reflected, err := client.transact(ctx, target)
			if err != nil {
				client.logf("candidates: STUN %s (%s): %v", server, target, err)
				return
			}
			replies[index] = reflected
		})
	}
	wait.Wait()
	var result []Candidate
	for _, reflected := range replies {
		reflected = netip.AddrPortFrom(reflected.Addr().Unmap(), reflected.Port())
		if reflected.IsValid() && publicEndpoint(reflected) {
			result = append(result, Candidate{Type: pairing.CandidateSTUN, Address: reflected, Source: server})
		}
	}
	return result
}

func (client *stunClient) transact(ctx context.Context, target netip.AddrPort) (netip.AddrPort, error) {
	txID := stun.NewTxID()
	replies := make(chan netip.AddrPort, 1)
	client.mu.Lock()
	client.waiting[txID] = stunWaiter{remote: target, replies: replies}
	client.mu.Unlock()
	defer func() {
		client.mu.Lock()
		delete(client.waiting, txID)
		client.mu.Unlock()
	}()

	request := stun.Request(txID)
	destination := net.UDPAddrFromAddrPort(target)
	retransmit := time.NewTimer(0)
	defer retransmit.Stop()
	interval := stunInitialRetransmit
	var lastErr error
	for {
		select {
		case reflected := <-replies:
			return reflected, nil
		case <-retransmit.C:
			if _, err := client.socket.WriteTo(request, destination); err != nil {
				lastErr = err
			}
			retransmit.Reset(interval)
			interval *= 2
		case <-ctx.Done():
			return netip.AddrPort{}, errors.Join(ctx.Err(), lastErr)
		}
	}
}

func addrPortOf(address net.Addr) netip.AddrPort {
	udp, ok := address.(*net.UDPAddr)
	if !ok {
		return netip.AddrPort{}
	}
	parsed := udp.AddrPort()
	return netip.AddrPortFrom(parsed.Addr().Unmap(), parsed.Port())
}
