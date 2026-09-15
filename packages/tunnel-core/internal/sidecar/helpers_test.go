// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const (
	testTimeout     = 15 * time.Second
	testProxySecret = "sidecar-test-proxy-secret-4f1c"
)

// frame is one line written by the sidecar: a response or an event.
type frame struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"error"`
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

type harnessOptions struct {
	torExecutable string
	startTor      func(tor.DesktopConfig) (TorService, error)
	mapper        func() *fakeMapper
	announcer     func(AnnouncerConfig) (Announcer, error)
	paths         *statedir.Paths
	listenHost    string
}

// harness runs Serve in process over pipes, the way the Rust supervisor
// drives the binary.
type harness struct {
	t      *testing.T
	paths  statedir.Paths
	input  *io.PipeWriter
	cancel context.CancelFunc
	exited chan int
	reader chan struct{}
	log    *lockedBuffer
	bridge *fakeBridge
	static string

	mu      sync.Mutex
	next    uint64
	pending map[uint64]chan frame
	events  []frame
	changed chan struct{}
	closed  bool
}

func startHarness(t *testing.T, options harnessOptions) *harness {
	t.Helper()
	paths := statedir.Paths{}
	if options.paths != nil {
		paths = *options.paths
	} else {
		prepared, err := statedir.Prepare(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		paths = prepared
	}
	host := options.listenHost
	if host == "" {
		host = "127.0.0.1"
	}
	network := NetworkConfig{
		ListenHost: host, StateInterval: 20 * time.Millisecond, STUNServers: []string{},
		StartTor: options.startTor, NewAnnouncer: options.announcer,
		NewPortMapper: func(uint16, func(string, ...any)) (candidates.PortMapper, error) {
			if options.mapper == nil {
				return nil, nil
			}
			return options.mapper(), nil
		},
	}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	h := &harness{
		t: t, paths: paths, input: inputWriter, cancel: cancel, exited: make(chan int, 1), reader: make(chan struct{}),
		log: &lockedBuffer{}, pending: map[uint64]chan frame{}, changed: make(chan struct{}),
	}
	logger := logx.New(h.log, 500)
	_ = logger.SetLevel("debug")
	go func() {
		code := Serve(ctx, Options{
			Paths: paths, Input: inputReader, Output: outputWriter, Logger: logger,
			HandshakeTimeout: testTimeout, TorExecutable: options.torExecutable, Network: network,
		})
		_ = outputWriter.Close()
		h.exited <- code
	}()
	hello := make(chan struct{})
	go h.read(outputReader, hello)
	select {
	case <-hello:
	case <-time.After(testTimeout):
		cancel()
		t.Fatal("sidecar did not send hello")
	}
	response := h.request("hello", map[string]any{"protocol": 1}, testTimeout)
	if !response.OK {
		t.Fatalf("hello failed: %+v", response.Error)
	}
	t.Cleanup(func() {
		h.shutdown(t)
		if t.Failed() {
			t.Logf("sidecar log:\n%s", h.log.tail(80))
		}
	})
	return h
}

func (h *harness) read(output io.Reader, hello chan<- struct{}) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	sentHello := false
	for scanner.Scan() {
		var received frame
		if err := json.Unmarshal(scanner.Bytes(), &received); err != nil {
			continue
		}
		if received.Event == "hello" && !sentHello {
			sentHello = true
			close(hello)
			continue
		}
		h.mu.Lock()
		if received.Event != "" {
			h.events = append(h.events, received)
			close(h.changed)
			h.changed = make(chan struct{})
		} else if waiter := h.pending[received.ID]; waiter != nil {
			delete(h.pending, received.ID)
			waiter <- received
		}
		h.mu.Unlock()
	}
	h.mu.Lock()
	h.closed = true
	close(h.changed)
	h.changed = make(chan struct{})
	h.mu.Unlock()
	close(h.reader)
}

func (h *harness) request(command string, args any, timeout time.Duration) frame {
	h.mu.Lock()
	h.next++
	id := h.next + 1
	waiter := make(chan frame, 1)
	h.pending[id] = waiter
	h.mu.Unlock()
	raw, _ := json.Marshal(map[string]any{"id": id, "cmd": command, "args": args})
	if _, err := h.input.Write(append(raw, '\n')); err != nil {
		return frame{ID: id, Error: &struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		}{Code: "closed", Message: err.Error()}}
	}
	select {
	case response := <-waiter:
		return response
	case <-time.After(timeout):
		return frame{ID: id, Error: &struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		}{Code: "test_timeout", Message: command}}
	}
}

// call runs command and decodes its result, failing the test on an error.
func (h *harness) call(t *testing.T, command string, args any, result any) {
	t.Helper()
	response := h.request(command, args, testTimeout)
	if !response.OK {
		t.Fatalf("%s failed: %+v", command, response.Error)
	}
	if result != nil {
		if err := json.Unmarshal(response.Result, result); err != nil {
			t.Fatalf("%s result %s: %v", command, response.Result, err)
		}
	}
}

// start calls net.start with the fixture edge and extra arguments.
func (h *harness) start(t *testing.T, extra map[string]any) NetStatus {
	t.Helper()
	if h.static == "" {
		h.static = t.TempDir()
		if err := os.WriteFile(filepath.Join(h.static, "mobile.html"), []byte("<!doctype html><title>Cialai</title>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if h.bridge == nil {
		h.bridge = startFakeBridge(t)
	}
	args := map[string]any{
		"desktopName": "MacBook de Teste", "requireApproval": false,
		"staticDir": h.static, "bridgeUrl": h.bridge.url, "proxySecret": testProxySecret,
	}
	for key, value := range extra {
		args[key] = value
	}
	var status NetStatus
	h.call(t, "net.start", args, &status)
	return status
}

// waitEvent returns the first event named name, at or after index from, that
// match accepts, and the index after it.
func (h *harness) waitEvent(t *testing.T, name string, from int, timeout time.Duration, match func(json.RawMessage) bool) (json.RawMessage, int) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		h.mu.Lock()
		events, changed, closed := h.events, h.changed, h.closed
		h.mu.Unlock()
		for index := from; index < len(events); index++ {
			if events[index].Event == name && (match == nil || match(events[index].Data)) {
				return events[index].Data, index + 1
			}
		}
		if closed {
			t.Fatalf("sidecar exited before event %s", name)
		}
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatalf("event %s not observed in %s", name, timeout)
		}
	}
}

func (h *harness) eventsNamed(name string) []json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	var data []json.RawMessage
	for _, event := range h.events {
		if event.Event == name {
			data = append(data, event.Data)
		}
	}
	return data
}

func (h *harness) eventCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.events)
}

// shutdown asks the sidecar to stop and waits for Serve to return.
func (h *harness) shutdown(t *testing.T) {
	t.Helper()
	select {
	case code := <-h.exited:
		h.exited <- code
		return
	default:
	}
	_ = h.request("shutdown", map[string]any{}, testTimeout)
	_ = h.input.Close()
	select {
	case code := <-h.exited:
		h.exited <- code
		if code != 0 {
			t.Errorf("sidecar exited with %d", code)
		}
		// Every frame written before the exit is recorded.
		<-h.reader
	case <-time.After(20 * time.Second):
		t.Error("sidecar did not exit after shutdown")
	}
	h.cancel()
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(data)
}

func (buffer *lockedBuffer) tail(lines int) string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	all := strings.Split(strings.TrimSpace(buffer.buffer.String()), "\n")
	return strings.Join(all[max(0, len(all)-lines):], "\n")
}

// fakeBridge stands in for the Rust PTY bridge: a loopback WebSocket echo
// that requires the edge secret and records the identity headers.
type fakeBridge struct {
	url string

	mu       sync.Mutex
	upgrades []http.Header
}

func startFakeBridge(t *testing.T) *fakeBridge {
	t.Helper()
	bridge := &fakeBridge{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Cialai-Proxy-Secret") != testProxySecret {
			http.Error(response, "Credencial da ponte recusada.", http.StatusForbidden)
			return
		}
		bridge.mu.Lock()
		bridge.upgrades = append(bridge.upgrades, request.Header.Clone())
		bridge.mu.Unlock()
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		ctx := context.Background()
		for {
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			if err := connection.Write(ctx, kind, data); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	bridge.url = server.URL
	return bridge
}

func (bridge *fakeBridge) headers() []http.Header {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return append([]http.Header(nil), bridge.upgrades...)
}

// fakeMapper is a gateway without mapping; blockProbe makes Probe wait for
// its context.
type fakeMapper struct {
	blockProbe bool
	mu         sync.Mutex
	closed     bool
}

func (*fakeMapper) Start(uint16, func(candidates.MapperEvent)) {}
func (*fakeMapper) Mapping() (candidates.Mapping, bool)        { return candidates.Mapping{}, false }
func (mapper *fakeMapper) Probe(ctx context.Context) (candidates.Services, error) {
	if mapper.blockProbe {
		<-ctx.Done()
		return candidates.Services{}, ctx.Err()
	}
	return candidates.Services{UPnP: true}, nil
}
func (mapper *fakeMapper) Close() error {
	mapper.mu.Lock()
	mapper.closed = true
	mapper.mu.Unlock()
	return nil
}

// fakeTor is an onion service without a tor process: its listener is plain
// loopback TCP and the test drives the supervisor states.
type fakeTor struct {
	address  string
	listener net.Listener
	onState  func(tor.State)

	mu     sync.Mutex
	state  tor.State
	closed bool
}

func startFakeTor(config tor.DesktopConfig) (*fakeTor, error) {
	key, _, err := tor.LoadOrCreateOnionKey(config.OnionKeyPath, nil)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	fake := &fakeTor{address: key.Address(), listener: listener, onState: config.OnState}
	fake.set(func(state *tor.State) { state.Phase = tor.PhaseStarting })
	return fake, nil
}

func (fake *fakeTor) set(change func(*tor.State)) {
	fake.mu.Lock()
	fake.state.Address = fake.address
	change(&fake.state)
	snapshot := fake.state
	fake.mu.Unlock()
	if fake.onState != nil {
		fake.onState(snapshot)
	}
}

func (fake *fakeTor) Address() string        { return fake.address }
func (fake *fakeTor) Listener() net.Listener { return fake.listener }
func (fake *fakeTor) State() tor.State {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.state
}

func (fake *fakeTor) Close() error {
	fake.mu.Lock()
	if fake.closed {
		fake.mu.Unlock()
		return nil
	}
	fake.closed = true
	fake.mu.Unlock()
	err := fake.listener.Close()
	if errors.Is(err, net.ErrClosed) {
		err = nil
	}
	fake.set(func(state *tor.State) {
		state.Phase = tor.PhaseStopped
		state.Published = false
	})
	return err
}

func (fake *fakeTor) isClosed() bool {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.closed
}

// fakeAnnouncer records what the network asked of the DNS-SD announcer.
type fakeAnnouncer struct {
	mu        sync.Mutex
	refreshes int
	closed    bool
}

func (announcer *fakeAnnouncer) Refresh() error {
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	announcer.refreshes++
	return nil
}

func (announcer *fakeAnnouncer) Close() error {
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	announcer.closed = true
	return nil
}

func (announcer *fakeAnnouncer) snapshot() (int, bool) {
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	return announcer.refreshes, announcer.closed
}
