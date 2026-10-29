package brotoclient

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoexec"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotorpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	ps "github.com/mitchellh/go-ps"
)

type Activity struct {
	Outcome string    `json:"outcome,omitempty"`
	Code    string    `json:"code,omitempty"`
	Path    string    `json:"path,omitempty"`
	TS      time.Time `json:"ts"`
	Actor   string    `json:"actor"`
	Cmd     string    `json:"cmd"`
}
type Status struct {
	PID       int        `json:"pid"`
	ParentPID int        `json:"parentPid"`
	State     string     `json:"state"`
	Host      string     `json:"host"`
	Digits    string     `json:"digits"`
	Transport string     `json:"transport"`
	Activity  []Activity `json:"activity"`
	Error     string     `json:"error,omitempty"`
}
type Config struct {
	// AllowPrivileged is an explicit override for trusted Go embedders and
	// isolated tests. It is false by default and has no JSON, CLI or IPC route.
	AllowPrivileged bool `json:"-"`
	Dir             string
	TorExecutable   string
	Name            string
	// TorEndpoints is an optional local SOCKS endpoint supplied by tests or
	// a native launcher. Packaged Broto normally owns TorExecutable instead.
	TorEndpoints *tor.Endpoints
	STUNServers  []string
}
type Client struct {
	mu              sync.Mutex
	auditMu         sync.Mutex
	sequenceMu      sync.Mutex
	sequence        uint32
	paths           statedir.Paths
	local           *identity.Identity
	name            string
	endpoint        *direct.Endpoint
	collector       *candidates.Collector
	tor             *tor.Client
	policy          Policy
	allowPrivileged bool
	host            *savedHost
	status          Status
	executor        *brotoexec.Executor
	conn            net.Conn
	send            func(brotorpc.Message) error
	events          chan brotorpc.Message
	disconnectAck   chan struct{}
	cancel          context.CancelFunc
	generation      uint64
	paused          bool
	base            context.Context
	stop            context.CancelFunc
	lock            *statedir.Lock
	torStop         func() error
}

func New(ctx context.Context, c Config) (*Client, error) {
	if c.Dir == "" {
		var err error
		c.Dir, err = DefaultDir()
		if err != nil {
			return nil, err
		}
	}
	paths, err := statedir.Prepare(c.Dir)
	if err != nil {
		return nil, err
	}
	if err = protectState(paths.Root); err != nil {
		return nil, err
	}
	lock, err := statedir.Acquire(paths, os.Getpid(), func(pid int) bool { process, err := ps.FindProcess(pid); return err == nil && process != nil })
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Client, error) { _ = lock.Release(); return nil, err }
	hostname, _ := os.Hostname()
	c.Name, err = brotoName(c.Name, hostname)
	if err != nil {
		return fail(err)
	}
	local, _, _, err := identity.Open(identity.Options{Role: identity.RoleBroto, Dir: paths.Root, Name: c.Name})
	if err != nil {
		return fail(err)
	}
	policy, err := loadPolicy(paths)
	if err != nil {
		return fail(err)
	}
	host, err := loadHost(paths)
	if err != nil {
		return fail(err)
	}
	packet, err := net.ListenPacket("udp", ":0")
	if err != nil {
		return fail(err)
	}
	endpoint, err := direct.New(direct.Config{PacketConn: packet, Identity: local})
	if err != nil {
		_ = packet.Close()
		return fail(err)
	}
	base, stop := context.WithCancel(ctx)
	client := &Client{paths: paths, local: local, name: c.Name, endpoint: endpoint, tor: tor.NewClient(), policy: policy, host: host, status: Status{State: "disconnected", Activity: []Activity{}}, base: base, stop: stop, lock: lock, allowPrivileged: c.AllowPrivileged}
	if raw, readErr := os.ReadFile(filepath.Join(paths.Root, "pty-sequence.json")); readErr == nil {
		if json.Unmarshal(raw, &client.sequence) != nil {
			_ = client.Close()
			return nil, errors.New("invalid session sequence")
		}
	} else if !os.IsNotExist(readErr) {
		_ = client.Close()
		return nil, readErr
	}
	client.collector, err = candidates.New(candidates.Config{Socket: endpoint, STUNServers: c.STUNServers})
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	if c.TorEndpoints != nil {
		if err = client.tor.SetTorEndpoints(*c.TorEndpoints); err != nil {
			_ = client.Close()
			return nil, err
		}
	}
	if c.TorExecutable != "" {
		closeTor, err := startTor(base, c.TorExecutable, filepath.Join(paths.Root, "tor-client"), client.tor)
		if err != nil {
			_ = client.Close()
			return nil, err
		}
		client.torStop = closeTor
	}
	if host != nil {
		client.mu.Lock()
		client.startLocked(host, nil)
		client.mu.Unlock()
	}
	return client, nil
}
func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.status
	s.PID = os.Getpid()
	s.ParentPID = os.Getppid()
	s.Activity = append([]Activity{}, s.Activity...)
	return s
}
func (c *Client) Close() error {
	c.stop()
	c.mu.Lock()
	c.stopLocked()
	c.mu.Unlock()
	if c.collector != nil {
		_ = c.collector.Close()
	}
	_ = c.endpoint.Close()
	if c.torStop != nil {
		_ = c.torStop()
	}
	return c.lock.Release()
}
func (c *Client) stopLocked() {
	c.send = nil
	c.events = nil
	c.disconnectAck = nil
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	if c.executor != nil {
		_ = c.executor.Close()
		c.executor = nil
	}
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.generation++
}
func (c *Client) Pause(v bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.paused = v
	if c.executor != nil {
		c.executor.SetPaused(v)
	}
	if v {
		c.status.State = "paused"
	} else if c.conn != nil {
		c.status.State = "connected"
	} else if c.host != nil {
		c.status.State = "waiting"
	} else {
		c.status.State = "disconnected"
	}
	if c.events != nil {
		raw, _ := json.Marshal(map[string]bool{"paused": v})
		select {
		case c.events <- brotorpc.Message{Event: "paused", Data: raw}:
		default:
			if c.conn != nil {
				_ = c.conn.Close()
			}
		}
	}
}
func (c *Client) Disconnect() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.executor != nil {
		_ = c.executor.Close()
	}
	if c.send != nil {
		send := c.send
		sent := make(chan struct{})
		go func() { _ = send(brotorpc.Message{Event: "disconnected"}); close(sent) }()
		select {
		case <-sent:
		case <-time.After(100 * time.Millisecond):
		}
		if c.disconnectAck != nil {
			select {
			case <-c.disconnectAck:
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	c.stopLocked()
	c.host = nil
	c.paused = false
	c.status = Status{State: "disconnected", Activity: c.status.Activity}
	return saveHost(c.paths, nil)
}
func (c *Client) Connect(code string) error {
	payload, err := pairing.DecodeBroto(strings.TrimSpace(code))
	if err != nil {
		return err
	}
	if !time.Now().Before(time.Unix(payload.ExpiresAt, 0)) {
		return errors.New("pairing expired")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopLocked()
	c.host = nil
	if err = saveHost(c.paths, nil); err != nil {
		return err
	}
	c.paused = false
	c.startLocked(nil, &payload)
	return nil
}
func (c *Client) startLocked(h *savedHost, p *pairing.Payload) {
	ctx, cancel := context.WithCancel(c.base)
	c.cancel = cancel
	c.generation++
	generation := c.generation
	c.status.State = "waiting"
	c.status.Error = ""
	if h != nil {
		c.status.Host = h.Card.Desktop.Name
		c.status.Digits = ""
	} else {
		c.status.Host = p.Desktop.Name
		c.status.Digits = pairing.ApprovalCode(p.PairID, c.local.PublicKey())
	}
	go c.run(ctx, generation, h, p)
}
func (c *Client) setError(g uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.generation == g {
		c.status.Error = "Não foi possível conectar ao hospedeiro."
		if !c.paused {
			c.status.State = "waiting"
		}
	}
}
func (c *Client) run(ctx context.Context, g uint64, h *savedHost, p *pairing.Payload) {
	if p != nil {
		var err error
		h, err = c.pair(ctx, *p)
		if err != nil {
			c.mu.Lock()
			if c.generation == g {
				c.status.State = "disconnected"
				c.status.Digits = ""
				c.status.Error = "Pareamento recusado, expirado ou interrompido. Gere um código novo."
			}
			c.mu.Unlock()
			return
		}
		c.mu.Lock()
		if c.generation != g {
			c.mu.Unlock()
			return
		}
		if err = saveHost(c.paths, h); err != nil {
			c.mu.Unlock()
			c.setError(g)
			return
		}
		c.host = h
		c.status.Digits = ""
		c.mu.Unlock()
	}
	puncher := &pathmgr.RendezvousPuncher{Local: c.local, Endpoint: c.endpoint, OpenControl: func(ctx context.Context, desktop pathmgr.Desktop) (io.ReadWriteCloser, error) {
		return c.tor.DialControlTLS(ctx, desktop.Onion, c.local, desktop.PublicKey)
	}, Candidates: func(ctx context.Context) ([]pairing.Candidate, error) {
		snapshot, err := c.collector.Collect(ctx)
		return snapshot.Pairing(), err
	}, Handler: rendezvous.Handler{ReachUpdate: func(card candidates.Card) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.generation == g {
			h.Card = card
			_ = saveHost(c.paths, h)
		}
	}}}
	manager, err := pathmgr.New(pathmgr.Config{Card: h.Card, Local: c.local, Direct: c.endpoint, Tor: c.tor, Puncher: puncher, OnCard: func(card candidates.Card) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.generation == g {
			h.Card = card
			_ = saveHost(c.paths, h)
		}
	}})
	if err != nil {
		c.setError(g)
		return
	}
	defer manager.Close()
	for ctx.Err() == nil {
		if _, err = manager.Connect(ctx); err == nil {
			var conn net.Conn
			conn, err = manager.DialContext(ctx, "tcp", "cialai.desktop:443")
			if err == nil {
				err = c.serve(ctx, g, conn, h.Token, manager.Status())
			}
		}
		if ctx.Err() != nil {
			return
		}
		c.setError(g)
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}
func (c *Client) serve(ctx context.Context, g uint64, conn net.Conn, token string, path pathmgr.Status) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	req, _ := http.NewRequest("GET", "http://cialai.desktop/broto", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "cialai-broto")
	if err := req.Write(conn); err != nil {
		return err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, req)
	if err != nil {
		return err
	}
	if response.StatusCode != 101 {
		response.Body.Close()
		return errors.New("broto channel refused")
	}
	if next := response.Header.Get("X-Cialai-Token-Next"); next != "" {
		if !strings.HasPrefix(next, "cbt1."+c.local.ID()+".") {
			return errors.New("invalid rotated token")
		}
		c.mu.Lock()
		if c.generation != g || c.host == nil {
			c.mu.Unlock()
			return context.Canceled
		}
		c.host.Token = next
		err = saveHost(c.paths, c.host)
		c.mu.Unlock()
		if err != nil {
			return err
		}
	}
	_ = conn.SetDeadline(time.Time{})
	var writeMu sync.Mutex
	write := func(message brotorpc.Message) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		err := brotorpc.Write(conn, message)
		_ = conn.SetWriteDeadline(time.Time{})
		return err
	}
	output := func(id uint32, p []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if brotorpc.WriteOutput(conn, id, p) != nil {
			_ = conn.Close()
		}
		_ = conn.SetWriteDeadline(time.Time{})
	}
	execOutput := func(id uint64, channel string, data []byte) {
		raw, _ := json.Marshal(map[string]any{"callId": id, "channel": channel, "data": data})
		if write(brotorpc.Message{Event: "exec.output", Data: raw}) != nil {
			_ = conn.Close()
		}
	}
	executor := brotoexec.New(brotoexec.Config{AllowFiles: c.policy.AllowFiles, FileRoots: c.policy.FileRoots, MaxFileMB: c.policy.MaxFileMB, MaxDuration: time.Duration(c.policy.MaxDurationMinutes) * time.Minute, OnExecOutput: execOutput, AllowExec: c.policy.AllowExec, AllowPTY: c.policy.AllowPTY, Dir: c.policy.Dir, Shell: c.policy.Shell, OnOutput: output, AllocateID: c.allocatePTYID, AllowPrivileged: c.allowPrivileged})
	defer executor.Close()
	c.mu.Lock()
	if c.generation != g {
		c.mu.Unlock()
		return context.Canceled
	}
	c.conn = conn
	c.send = write
	ack := make(chan struct{})
	c.disconnectAck = ack
	events := make(chan brotorpc.Message, 16)
	c.events = events
	c.executor = executor
	c.status.State = "waiting"
	c.status.Error = ""
	if path.Active != nil {
		c.status.Transport = path.Active.Transport
	}
	if c.paused {
		executor.SetPaused(true)
		c.status.State = "paused"
	}
	state, _ := json.Marshal(map[string]bool{"paused": c.paused})
	events <- brotorpc.Message{Event: "paused", Data: state}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.generation == g {
			c.conn = nil
			c.send = nil
			c.events = nil
			c.disconnectAck = nil
			c.executor = nil
		}
		c.mu.Unlock()
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event := <-events:
				if write(event) != nil {
					_ = conn.Close()
					return
				}
			}
		}
	}()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	active := make(chan struct{}, 16)
	negotiated := false
	for {
		message, err := brotorpc.Read(reader)
		if err != nil {
			return err
		}
		if message.Event == "disconnected.ack" {
			select {
			case <-ack:
			default:
				close(ack)
			}
			continue
		}
		if message.Cmd == "" {
			continue
		}
		if !negotiated {
			var hello struct {
				Version int `json:"version"`
			}
			if message.Cmd != "hello" || json.Unmarshal(message.Args, &hello) != nil || hello.Version != 1 {
				_ = write(brotorpc.Message{ID: message.ID, Error: "Versão de protocolo incompatível."})
				return errors.New("protocol negotiation required")
			}
			result, helloErr := executor.Handle(ctx, "hello", message.Args)
			reply := brotorpc.Message{ID: message.ID, OK: helloErr == nil}
			if helloErr != nil {
				reply.Error = brotoexec.Diagnostic(helloErr)
			} else {
				raw, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					_ = conn.Close()
					return marshalErr
				}
				reply.Result = raw
			}
			if err = write(reply); err != nil {
				return err
			}
			if helloErr != nil {
				return helloErr
			}
			negotiated = true
			c.mu.Lock()
			if c.generation == g {
				if c.paused {
					c.status.State = "paused"
				} else {
					c.status.State = "connected"
				}
			}
			c.mu.Unlock()
			continue
		}
		if message.Cmd == "exec.cancel" || message.Cmd == "files.cancel" {
			result, err := executor.Handle(ctx, message.Cmd, message.Args)
			raw, _ := json.Marshal(result)
			reply := brotorpc.Message{ID: message.ID, OK: err == nil, Result: raw}
			if err != nil {
				reply.Error = brotoexec.Diagnostic(err)
			}
			if write(reply) != nil {
				return errors.New("cancel response failed")
			}
			continue
		}
		select {
		case active <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		go func(m brotorpc.Message) {
			defer func() { <-active }()
			if m.Cmd != "files.get" && m.Cmd != "files.put" {
				c.audit(g, m.Actor, m.Cmd)
			}
			result, runErr := executor.HandleCall(ctx, m.ID, m.Cmd, m.Args)
			c.auditFileResult(g, m, result, runErr)
			reply := brotorpc.Message{ID: m.ID, OK: runErr == nil}
			if runErr != nil {
				reply.Error = brotoexec.Diagnostic(runErr)
			} else {
				raw, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					_ = conn.Close()
					return
				}
				reply.Result = raw
			}
			if write(reply) != nil {
				_ = conn.Close()
			}
		}(message)
	}
}
func (c *Client) allocatePTYID() (uint32, error) {
	c.sequenceMu.Lock()
	defer c.sequenceMu.Unlock()
	if c.sequence == ^uint32(0) {
		return 0, errors.New("session id exhausted")
	}
	next := c.sequence + 1
	raw, _ := json.Marshal(next)
	if err := c.paths.WriteAtomic(filepath.Join(c.paths.Root, "pty-sequence.json"), raw); err != nil {
		return 0, err
	}
	c.sequence = next
	return next, nil
}
func (c *Client) audit(g uint64, actor, verb string, paths ...string) {
	switch verb {
	case "files.list", "files.stat", "pty.list", "pty.read":
		// The host polls these every few seconds to list sessions and stream
		// output. They change nothing and would bury the real activity.
		return
	case "files.get", "files.put", "files.cancel", "exec.cancel", "hello", "exec", "pty.open", "pty.write", "pty.resize", "pty.kill":
	default:
		verb = "unknown"
	}
	switch actor {
	case "human", "phone", "ai":
	default:
		actor = "human"
	}
	activity := Activity{TS: time.Now().UTC(), Actor: actor, Cmd: verb}
	if len(paths) > 0 {
		activity.Path = paths[0]
	}
	c.recordActivity(g, activity)
}
func (c *Client) recordActivity(g uint64, activity Activity) {
	switch activity.Actor {
	case "ai", "phone", "human":
	default:
		activity.Actor = "human"
	}
	c.mu.Lock()
	if c.generation == g && c.coalesce(activity) {
		c.mu.Unlock()
		return
	}
	if c.generation == g {
		c.status.Activity = append(c.status.Activity, activity)
		if len(c.status.Activity) > 256 {
			c.status.Activity = append([]Activity{}, c.status.Activity[len(c.status.Activity)-256:]...)
		}
	}
	c.mu.Unlock()
	c.auditMu.Lock()
	defer c.auditMu.Unlock()
	path := filepath.Join(c.paths.Root, "audit.jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		if err = os.Rename(path, path+".1"); err != nil {
			return
		}
	}
	raw, _ := json.Marshal(activity)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err == nil {
		_, _ = f.Write(append(raw, '\n'))
		_ = f.Close()
	}
}

// coalesce folds typing and resizing into the line already showing them. They
// arrive one message per key or per step; a burst from the same author within
// 30 seconds stays one line with the time of its last message. Callers hold c.mu.
func (c *Client) coalesce(activity Activity) bool {
	if activity.Cmd != "pty.write" && activity.Cmd != "pty.resize" {
		return false
	}
	last := len(c.status.Activity) - 1
	if last < 0 {
		return false
	}
	previous := &c.status.Activity[last]
	if previous.Actor != activity.Actor || previous.Cmd != activity.Cmd || activity.TS.Sub(previous.TS) >= 30*time.Second {
		return false
	}
	previous.TS = activity.TS
	return true
}

type pairAnswer struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	Desktop  struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
	} `json:"desktop"`
	Reach struct {
		Onion      string              `json:"onion"`
		PublicKey  string              `json:"publicKey"`
		Candidates []pairing.Candidate `json:"candidates"`
	} `json:"reach"`
}

func (c *Client) pair(ctx context.Context, p pairing.Payload) (*savedHost, error) {
	key, _ := identity.ParsePublicKey(p.Desktop.PublicKey)
	ctx, cancel := context.WithDeadline(ctx, time.Unix(p.ExpiresAt, 0))
	defer cancel()
	body, _ := json.Marshal(map[string]any{"v": 2, "kind": "broto", "pairId": p.PairID, "secret": p.Secret, "device": map[string]string{"name": c.name, "model": runtime.GOARCH, "platform": runtime.GOOS, "app": "broto-1", "publicKey": c.local.PublicKeyString()}})
	for ctx.Err() == nil {
		conn, err := c.reachPair(ctx, p, key)
		if err != nil {
			return nil, err
		}
		status, raw, err := exchangePair(ctx, conn, body)
		if err != nil {
			return nil, err
		}
		if status == 200 {
			var answer pairAnswer
			if json.Unmarshal(raw, &answer) != nil || answer.DeviceID != c.local.ID() || !strings.HasPrefix(answer.Token, "cbt1."+c.local.ID()+".") || answer.Desktop.ID != p.Desktop.ID || answer.Desktop.PublicKey != p.Desktop.PublicKey || answer.Reach.PublicKey != p.Desktop.PublicKey {
				return nil, errors.New("invalid pairing reply")
			}
			card, err := candidates.NewCard(p.Desktop, answer.Reach.Onion, answer.Reach.Candidates, time.Now(), 0)
			if err != nil {
				return nil, err
			}
			return &savedHost{Card: card, Token: answer.Token, DeviceID: answer.DeviceID}, nil
		}
		if status != 202 {
			return nil, errors.New("pairing refused")
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	return nil, ctx.Err()
}

type pairConn struct {
	transport.Stream
	session transport.Session
}

func (p *pairConn) Close() error { _ = p.Stream.Close(); return p.session.Close() }
func (c *Client) reachPair(ctx context.Context, p pairing.Payload, key ed25519.PublicKey) (net.Conn, error) {
	list := []netip.AddrPort{}
	for _, candidate := range p.Candidates {
		if addr, err := netip.ParseAddrPort(candidate.Address); err == nil {
			list = append(list, addr)
		}
	}
	attempt, cancel := context.WithTimeout(ctx, 4*time.Second)
	session, err := c.endpoint.DialCandidates(attempt, list, key)
	if err == nil {
		stream, streamErr := session.OpenStream(attempt)
		cancel()
		if streamErr != nil {
			_ = session.Close()
			return nil, streamErr
		}
		return &pairConn{stream, session}, nil
	}
	cancel()
	host, _, err := net.SplitHostPort(p.Onion)
	if err != nil {
		return nil, err
	}
	for ctx.Err() == nil {
		attempt, cancel = context.WithTimeout(ctx, 20*time.Second)
		conn, err := c.tor.DialTLS(attempt, host, c.local, key)
		cancel()
		if err == nil {
			return conn, nil
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	return nil, ctx.Err()
}
func exchangePair(ctx context.Context, conn net.Conn, body []byte) (int, []byte, error) {
	defer conn.Close()
	deadline := time.Now().Add(15 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	req, _ := http.NewRequest("POST", "http://cialai.desktop/pair", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if err := req.Write(conn); err != nil {
		return 0, nil, err
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if len(raw) > 16384 {
		return 0, nil, fmt.Errorf("pairing reply too large")
	}
	return response.StatusCode, raw, err
}

func (c *Client) auditFileResult(g uint64, m brotorpc.Message, result any, runErr error) {
	if m.Cmd != "files.get" && m.Cmd != "files.put" {
		return
	}
	if runErr == nil {
		v, ok := result.(map[string]any)
		if !ok || (v["eof"] != true && v["complete"] != true) {
			return
		}
	}
	var args struct {
		Path string `json:"path"`
	}
	json.Unmarshal(m.Args, &args)
	entry := Activity{TS: time.Now().UTC(), Actor: m.Actor, Cmd: m.Cmd, Path: args.Path, Outcome: "ok"}
	if runErr != nil {
		entry.Outcome = "error"
		entry.Code = "file_io_failed"
		var safe *brotoexec.Error
		if errors.As(runErr, &safe) {
			entry.Code = safe.Code
		}
	}
	c.recordActivity(g, entry)
}
