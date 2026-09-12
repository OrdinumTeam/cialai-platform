// SPDX-License-Identifier: Apache-2.0
package node

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

type Logf = logger.Logf

func NewTSNetManager(userLog, debugLog Logf) *Manager {
	return NewManager(func(config Config) (Engine, error) {
		server := &tsnet.Server{
			Dir:        config.StateDir,
			ControlURL: config.ControlURL,
			AuthKey:    config.AuthKey,
			Hostname:   config.Hostname,
			Ephemeral:  false,
			UserLogf:   userLog,
			Logf:       debugLog,
		}
		if server.UserLogf == nil {
			server.UserLogf = func(string, ...any) {}
		}
		return &tsnetEngine{server: server, forceLogin: config.ForceLogin}, nil
	})
}

type tsnetEngine struct {
	server     *tsnet.Server
	forceLogin bool
}

func (engine *tsnetEngine) Up(ctx context.Context) (Status, error) {
	if err := prepareTSNetLogin(ctx, engine.forceLogin, engine.server.Start, func(ctx context.Context) error {
		client, err := engine.server.LocalClient()
		if err != nil {
			return err
		}
		return client.StartLoginInteractive(ctx)
	}); err != nil {
		return Status{}, err
	}
	status, err := engine.server.Up(ctx)
	if err != nil {
		return Status{}, err
	}
	return fromIPNStatus(status), nil
}

func prepareTSNetLogin(ctx context.Context, force bool, start func() error, login func(context.Context) error) error {
	if !force {
		return nil
	}
	if err := start(); err != nil {
		return err
	}
	return login(ctx)
}

func (engine *tsnetEngine) Status(ctx context.Context) (Status, error) {
	client, err := engine.server.LocalClient()
	if err != nil {
		return Status{}, err
	}
	status, err := client.Status(ctx)
	if err != nil {
		return Status{}, err
	}
	return fromIPNStatus(status), nil
}

func (engine *tsnetEngine) Close() error { return engine.server.Close() }

func (engine *tsnetEngine) Rebind(ctx context.Context) error {
	client, err := engine.server.LocalClient()
	if err != nil {
		return err
	}
	return client.DebugAction(ctx, "rebind")
}

func (engine *tsnetEngine) Restun(ctx context.Context) error {
	client, err := engine.server.LocalClient()
	if err != nil {
		return err
	}
	return client.DebugAction(ctx, "restun")
}

func (engine *tsnetEngine) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	return engine.server.Dial(ctx, network, address)
}

func (engine *tsnetEngine) Listen(network, address string) (net.Listener, error) {
	return engine.server.Listen(network, address)
}

func (engine *tsnetEngine) WhoIs(ctx context.Context, remoteAddr string) (Identity, error) {
	client, err := engine.server.LocalClient()
	if err != nil {
		return Identity{}, err
	}
	response, err := client.WhoIs(ctx, remoteAddr)
	if err != nil {
		return Identity{}, err
	}
	if response == nil || response.Node == nil || response.UserProfile == nil {
		return Identity{}, errors.New("WhoIs returned no node identity")
	}
	identity := Identity{
		NodeKey: response.Node.Key.String(),
		NodeID:  strconv.FormatInt(int64(response.Node.ID), 10),
		UserID:  strconv.FormatInt(int64(response.UserProfile.ID), 10),
	}
	for _, prefix := range response.Node.Addresses {
		if prefix.Addr().Is4() {
			identity.IP = prefix.Addr().String()
			break
		}
	}
	if identity.IP != "" {
		return identity, nil
	}
	if host, _, splitErr := net.SplitHostPort(remoteAddr); splitErr == nil {
		identity.IP = host
	} else if address, parseErr := netip.ParseAddr(remoteAddr); parseErr == nil {
		identity.IP = address.String()
	}
	return identity, nil
}

func (engine *tsnetEngine) Logout(ctx context.Context) error {
	client, err := engine.server.LocalClient()
	if err != nil {
		return err
	}
	return client.Logout(ctx)
}

func fromIPNStatus(source *ipnstate.Status) Status {
	if source == nil {
		return Status{State: Offline, Peers: []Peer{}}
	}
	result := Status{State: stateFromBackend(source.BackendState), Health: append([]string(nil), source.Health...), Peers: make([]Peer, 0, len(source.Peer))}
	for _, address := range source.TailscaleIPs {
		if address.Is4() && result.IP4 == "" {
			result.IP4 = address.String()
		}
		if address.Is6() && result.IP6 == "" {
			result.IP6 = address.String()
		}
	}
	if source.Self != nil {
		result.DNSName = strings.TrimSuffix(source.Self.DNSName, ".")
		result.NodeKey = source.Self.PublicKey.String()
		if source.Self.KeyExpiry != nil {
			result.KeyExpiry = *source.Self.KeyExpiry
		}
	}
	for publicKey, sourcePeer := range source.Peer {
		if sourcePeer == nil {
			continue
		}
		peer := Peer{NodeKey: publicKey.String(), Name: sourcePeer.HostName, Online: sourcePeer.Online, LastSeen: sourcePeer.LastSeen}
		if peer.NodeKey == "" {
			peer.NodeKey = sourcePeer.PublicKey.String()
		}
		for _, address := range sourcePeer.TailscaleIPs {
			if address.Is4() && peer.IP4 == "" {
				peer.IP4 = address.String()
			}
			if address.Is6() && peer.IP6 == "" {
				peer.IP6 = address.String()
			}
		}
		result.Peers = append(result.Peers, peer)
	}
	return normalize(result)
}

func stateFromBackend(state string) State {
	switch strings.ToLower(state) {
	case "running":
		return Running
	case "starting", "nostate":
		return Starting
	case "needslogin", "needsmachineauth":
		return NeedsLogin
	case "stopped":
		return Stopped
	default:
		return Offline
	}
}
