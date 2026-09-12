// SPDX-License-Identifier: Apache-2.0
// Package node owns one userspace tailnet node and exposes stable status and
// peer lookup contracts to the edge and proxy packages.
package node

import (
	"context"
	"errors"
	"net"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrRunning = errors.New("node is already running")
	ErrStopped = errors.New("node is stopped")
)

type State string

const (
	Stopped    State = "stopped"
	Starting   State = "starting"
	NeedsLogin State = "needs-login"
	Running    State = "running"
	Offline    State = "offline"
)

type Config struct {
	StateDir   string
	ControlURL string
	UserID     string
	UserName   string
	Hostname   string
	AuthKey    string
	ForceLogin bool
}

type Peer struct {
	NodeKey  string    `json:"nodeKey"`
	Name     string    `json:"name"`
	Online   bool      `json:"online"`
	IP4      string    `json:"ip4,omitempty"`
	IP6      string    `json:"ip6,omitempty"`
	LastSeen time.Time `json:"lastSeen,omitempty"`
}

type Identity struct {
	NodeKey string `json:"nodeKey"`
	NodeID  string `json:"nodeId"`
	UserID  string `json:"userId"`
	IP      string `json:"ip"`
}

type Status struct {
	State     State     `json:"state"`
	IP4       string    `json:"ip4,omitempty"`
	IP6       string    `json:"ip6,omitempty"`
	DNSName   string    `json:"dnsName,omitempty"`
	NodeKey   string    `json:"nodeKey,omitempty"`
	KeyExpiry time.Time `json:"keyExpiry,omitempty"`
	Health    []string  `json:"health,omitempty"`
	Peers     []Peer    `json:"peers"`
}

type Engine interface {
	Up(context.Context) (Status, error)
	Status(context.Context) (Status, error)
	Close() error
	Rebind(context.Context) error
	Restun(context.Context) error
	Dial(context.Context, string, string) (net.Conn, error)
	Listen(string, string) (net.Listener, error)
	WhoIs(context.Context, string) (Identity, error)
	Logout(context.Context) error
}

type Factory func(Config) (Engine, error)

type Manager struct {
	mu       sync.RWMutex
	factory  Factory
	engine   Engine
	status   Status
	peers    map[string]Peer
	starting bool
}

func NewManager(factory Factory) *Manager {
	return &Manager{factory: factory, status: Status{State: Stopped, Peers: []Peer{}}, peers: map[string]Peer{}}
}

func validateConfig(config Config) error {
	if !filepath.IsAbs(config.StateDir) || strings.TrimSpace(config.Hostname) == "" {
		return errors.New("absolute state directory and hostname are required")
	}
	parsed, err := url.Parse(config.ControlURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return errors.New("valid control URL is required")
	}
	if parsed.Scheme == "http" {
		ip := net.ParseIP(parsed.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return errors.New("control URL must use HTTPS outside loopback")
		}
	}
	return nil
}

func (manager *Manager) Up(ctx context.Context, config Config) (Status, error) {
	if err := validateConfig(config); err != nil {
		return Status{}, err
	}
	manager.mu.Lock()
	if manager.starting || manager.engine != nil {
		manager.mu.Unlock()
		return Status{}, ErrRunning
	}
	manager.starting = true
	manager.status = Status{State: Starting, Peers: []Peer{}}
	manager.mu.Unlock()

	engine, err := manager.factory(config)
	if err != nil {
		manager.failStart()
		return Status{}, err
	}
	status, err := engine.Up(ctx)
	if err != nil {
		_ = engine.Close()
		manager.failStart()
		return Status{}, err
	}
	status = normalize(status)
	manager.mu.Lock()
	manager.starting = false
	manager.engine = engine
	manager.setStatusLocked(status)
	manager.mu.Unlock()
	return cloneStatus(status), nil
}

func (manager *Manager) failStart() {
	manager.mu.Lock()
	manager.starting = false
	manager.status = Status{State: Stopped, Peers: []Peer{}}
	manager.peers = map[string]Peer{}
	manager.mu.Unlock()
}

func (manager *Manager) Down() error {
	manager.mu.Lock()
	engine := manager.engine
	manager.engine = nil
	manager.starting = false
	manager.status = Status{State: Stopped, Peers: []Peer{}}
	manager.peers = map[string]Peer{}
	manager.mu.Unlock()
	if engine == nil {
		return nil
	}
	return engine.Close()
}

func (manager *Manager) Status(ctx context.Context) (Status, error) {
	engine, err := manager.currentEngine()
	if err != nil {
		return manager.Snapshot(), err
	}
	status, err := engine.Status(ctx)
	if err != nil {
		return manager.Snapshot(), err
	}
	status = normalize(status)
	manager.mu.Lock()
	manager.setStatusLocked(status)
	manager.mu.Unlock()
	return cloneStatus(status), nil
}

func (manager *Manager) Snapshot() Status {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	return cloneStatus(manager.status)
}

func (manager *Manager) Peer(nodeKey string) (Peer, bool) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	peer, ok := manager.peers[nodeKey]
	return peer, ok
}

func (manager *Manager) NotifyNetworkChange(ctx context.Context, reachable bool) error {
	engine, err := manager.currentEngine()
	if err != nil {
		return err
	}
	if !reachable {
		manager.mu.Lock()
		manager.status.State = Offline
		manager.mu.Unlock()
		return nil
	}
	if err := engine.Rebind(ctx); err != nil {
		return err
	}
	if err := engine.Restun(ctx); err != nil {
		return err
	}
	_, err = manager.Status(ctx)
	return err
}

func (manager *Manager) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	engine, err := manager.currentEngine()
	if err != nil {
		return nil, err
	}
	return engine.Dial(ctx, network, address)
}

func (manager *Manager) Listen(network, address string) (net.Listener, error) {
	engine, err := manager.currentEngine()
	if err != nil {
		return nil, err
	}
	return engine.Listen(network, address)
}

func (manager *Manager) WhoIs(ctx context.Context, remoteAddr string) (Identity, error) {
	engine, err := manager.currentEngine()
	if err != nil {
		return Identity{}, err
	}
	return engine.WhoIs(ctx, remoteAddr)
}

func (manager *Manager) Logout(ctx context.Context) error {
	engine, err := manager.currentEngine()
	if err != nil {
		return err
	}
	if err := engine.Logout(ctx); err != nil {
		return err
	}
	return manager.Down()
}

func (manager *Manager) currentEngine() (Engine, error) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	if manager.engine == nil {
		return nil, ErrStopped
	}
	return manager.engine, nil
}

func (manager *Manager) setStatusLocked(status Status) {
	manager.status = cloneStatus(status)
	manager.peers = make(map[string]Peer, len(status.Peers))
	for _, peer := range status.Peers {
		if peer.NodeKey != "" {
			manager.peers[peer.NodeKey] = peer
		}
	}
}

func normalize(status Status) Status {
	if status.State == "" {
		status.State = Offline
	}
	status.Peers = append([]Peer(nil), status.Peers...)
	sort.Slice(status.Peers, func(left, right int) bool { return status.Peers[left].NodeKey < status.Peers[right].NodeKey })
	status.Health = append([]string(nil), status.Health...)
	return status
}

func cloneStatus(status Status) Status {
	status.Peers = append([]Peer(nil), status.Peers...)
	status.Health = append([]string(nil), status.Health...)
	return status
}
