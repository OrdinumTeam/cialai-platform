// SPDX-License-Identifier: Apache-2.0
//go:build netlab

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// The desktop role stands in for the Rust supervisor of the desktop app. It
// owns what the supervisor owns, the PTY bridge and the static site, runs the
// real cialai-tunnel serve-stdio as its child and passes the stdio protocol
// through: the test writes requests to stdin and reads responses and events
// from stdout, exactly as the supervisor does. Like the supervisor it closes
// the bridge sockets of a revoked device with 4401 when the sidecar emits
// devices.changed with revoked.
//
// Lines carrying a "netlab" key are for this process instead of the sidecar:
//
//	{"netlab":"restart","signal":"TERM|KILL"}  signal the sidecar, wait for it
//	                                           and start it again
//	{"netlab":"bridge"}                        report the bridge upgrades
//
// and it writes {"netlab":"ready",...}, {"netlab":"started",...} and
// {"netlab":"exited",...} lines of its own.

type desktopNode struct {
	out    *lineWriter
	logger *log.Logger
	bridge *labBridge

	tunnel, tor, state string

	mu    sync.Mutex
	child *exec.Cmd
	stdin io.WriteCloser
	done  chan struct{}
}

func runDesktop(args []string) int {
	flags := flag.NewFlagSet("desktop", flag.ContinueOnError)
	tunnel := flags.String("tunnel", "/opt/netlab/cialai-tunnel", "binário do sidecar")
	torBin := flags.String("tor", "/opt/netlab/tor/tor", "executável do Tor usado pelo sidecar")
	state := flags.String("state", "/var/lib/cialai", "diretório de estado do sidecar")
	static := flags.String("static", "/tmp/netlab-static", "site estático da borda")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	node := &desktopNode{
		out: &lineWriter{out: os.Stdout}, logger: log.New(os.Stderr, "desktop: ", log.LstdFlags|log.Lmicroseconds),
		tunnel: *tunnel, tor: *torBin, state: *state,
	}
	if err := os.MkdirAll(*static, 0o755); err != nil {
		node.logger.Print(err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(*static, "mobile.html"), []byte("<!doctype html><title>Cialai</title><main>Cialai mobile no laboratório</main>"), 0o644); err != nil {
		node.logger.Print(err)
		return 1
	}
	bridge, err := startLabBridge()
	if err != nil {
		node.logger.Print(err)
		return 1
	}
	node.bridge = bridge
	node.out.json(map[string]any{"netlab": "ready", "bridgeUrl": bridge.url, "staticDir": *static})
	if err := node.start(); err != nil {
		node.logger.Print(err)
		return 1
	}

	scanner := newLineScanner(os.Stdin)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var control struct {
			Netlab string `json:"netlab"`
			Signal string `json:"signal"`
		}
		if json.Unmarshal(line, &control) == nil && control.Netlab != "" {
			node.handle(control.Netlab, control.Signal)
			continue
		}
		node.mu.Lock()
		stdin := node.stdin
		node.mu.Unlock()
		if _, err := stdin.Write(append(line, '\n')); err != nil {
			node.logger.Printf("sidecar stdin: %v", err)
		}
	}
	// The test closed stdin: end the sidecar like the supervisor quitting.
	node.stop(syscall.SIGTERM)
	return 0
}

func (node *desktopNode) start() error {
	command := exec.Command(node.tunnel, "serve-stdio", "--state-dir", node.state,
		"--parent-pid", strconv.Itoa(os.Getpid()), "--tor-bin", node.tor, "--log-level", "debug",
		"--log-file", filepath.Join(os.TempDir(), "cialai-tunnel.log"))
	command.Stderr = os.Stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	node.mu.Lock()
	node.child, node.stdin, node.done = command, stdin, done
	node.mu.Unlock()
	node.out.json(map[string]any{"netlab": "started", "pid": command.Process.Pid})
	go func() {
		scanner := newLineScanner(stdout)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			node.tap(line)
			node.out.line(line)
		}
		err := command.Wait()
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		node.out.json(map[string]any{"netlab": "exited", "pid": command.Process.Pid, "code": code, "error": fmt.Sprint(err)})
		close(done)
	}()
	return nil
}

// tap closes the bridge sockets of a revoked device, as the supervisor does.
func (node *desktopNode) tap(line []byte) {
	var event struct {
		Event string `json:"event"`
		Data  struct {
			DeviceID string `json:"deviceId"`
			Revoked  bool   `json:"revoked"`
		} `json:"data"`
	}
	if json.Unmarshal(line, &event) != nil || event.Event != "devices.changed" || !event.Data.Revoked {
		return
	}
	closed := node.bridge.closeDevice(event.Data.DeviceID, 4401, "Dispositivo revogado.")
	node.logger.Printf("revogação de %s fechou %d sockets da ponte com 4401", event.Data.DeviceID, closed)
}

func (node *desktopNode) handle(command, signalName string) {
	switch command {
	case "restart":
		signal := syscall.SIGTERM
		if signalName == "KILL" {
			signal = syscall.SIGKILL
		}
		started := time.Now()
		node.stop(signal)
		if err := node.start(); err != nil {
			node.out.json(map[string]any{"netlab": "restart", "ok": false, "error": err.Error()})
			return
		}
		node.out.json(map[string]any{"netlab": "restart", "ok": true, "ms": millis(started)})
	case "bridge":
		node.out.json(map[string]any{"netlab": "bridge", "ok": true, "upgrades": node.bridge.snapshot()})
	default:
		node.out.json(map[string]any{"netlab": command, "ok": false, "error": "comando desconhecido"})
	}
}

// stop signals the sidecar and waits for it; TERM gets ten seconds before the
// kill, like the supervisor.
func (node *desktopNode) stop(signal syscall.Signal) {
	node.mu.Lock()
	child, stdin, done := node.child, node.stdin, node.done
	node.mu.Unlock()
	if child == nil {
		return
	}
	if signal == syscall.SIGTERM {
		_ = stdin.Close()
	}
	_ = child.Process.Signal(signal)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = child.Process.Kill()
		<-done
	}
}

// labBridge is the fake PTY bridge: a loopback WebSocket echo that records the
// identity headers the edge adds and can close the sockets of one device.
type labBridge struct {
	url string

	mu       sync.Mutex
	upgrades []map[string]string
	sockets  map[*websocket.Conn]string
}

func startLabBridge() (*labBridge, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	bridge := &labBridge{url: "http://" + listener.Addr().String(), sockets: map[*websocket.Conn]string{}}
	go func() {
		_ = http.Serve(listener, http.HandlerFunc(bridge.serve))
	}()
	return bridge, nil
}

func (bridge *labBridge) serve(response http.ResponseWriter, request *http.Request) {
	headers := map[string]string{
		"deviceId":  request.Header.Get("X-Cialai-Device-Id"),
		"deviceKey": request.Header.Get("X-Cialai-Device-Key"),
		"transport": request.Header.Get("X-Cialai-Transport"),
		"secret":    fmt.Sprint(request.Header.Get("X-Cialai-Proxy-Secret") != ""),
	}
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	bridge.mu.Lock()
	bridge.upgrades = append(bridge.upgrades, headers)
	bridge.sockets[connection] = headers["deviceId"]
	bridge.mu.Unlock()
	defer func() {
		bridge.mu.Lock()
		delete(bridge.sockets, connection)
		bridge.mu.Unlock()
	}()
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
}

func (bridge *labBridge) snapshot() []map[string]string {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return append([]map[string]string(nil), bridge.upgrades...)
}

func (bridge *labBridge) closeDevice(deviceID string, status websocket.StatusCode, reason string) int {
	bridge.mu.Lock()
	var closing []*websocket.Conn
	for connection, owner := range bridge.sockets {
		if owner == deviceID {
			closing = append(closing, connection)
		}
	}
	bridge.mu.Unlock()
	for _, connection := range closing {
		go func() { _ = connection.Close(status, reason) }()
	}
	return len(closing)
}
