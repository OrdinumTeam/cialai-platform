// SPDX-License-Identifier: Apache-2.0
//go:build netlab

package integration_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The helpers below drive tools/net-lab: they build the linux binaries, bring
// the Compose project up and talk to the processes inside the containers
// through docker compose exec, so no port of the laboratory is published on
// the host and no management network can shortcut the routers.

const (
	netLabProject     = "cialai-netlab"
	netLabProxySecret = "netlab-proxy-secret-2b7d41c9"
	netLabDesktopName = "Mac do Laboratório"
	netLabSTUN        = "203.0.113.3:3478"
	netLabCallTimeout = 45 * time.Second
	netLabEventWait   = 60 * time.Second
)

type netLab struct {
	t        *testing.T
	root     string
	compose  string
	bin      string
	logs     string
	env      []string
	mu       sync.Mutex
	results  []*scenarioResult
	sequence int
}

// startNetLab builds cialai-tunnel and netlab-node for the Docker server
// architecture and starts a clean Compose project.
func startNetLab(t *testing.T) *netLab {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Fatal("o laboratório precisa do Docker com Compose")
	}
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	lab := &netLab{t: t, root: root, compose: filepath.Join(root, "tools", "net-lab", "compose.yaml"), bin: t.TempDir()}
	lab.logs = os.Getenv("NETLAB_ARTIFACTS")
	if lab.logs == "" {
		lab.logs = t.TempDir()
	}
	if err := os.MkdirAll(lab.logs, 0o755); err != nil {
		t.Fatal(err)
	}
	lab.env = append(os.Environ(), "NETLAB_BIN="+lab.bin)

	arch := strings.TrimSpace(lab.mustRun(t, "docker", "version", "--format", "{{.Server.Arch}}"))
	if arch != "amd64" && arch != "arm64" {
		t.Fatalf("arquitetura do Docker não suportada: %q", arch)
	}
	started := time.Now()
	module := filepath.Join(root, "packages", "tunnel-core")
	build := func(output string, args ...string) {
		command := exec.Command("go", append([]string{"build", "-trimpath", "-o", output}, args...)...)
		command.Dir = module
		command.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("go build %v: %v\n%s", args, err, out)
		}
	}
	build(filepath.Join(lab.bin, "cialai-tunnel"), "./cmd/cialai-tunnel")
	build(filepath.Join(lab.bin, "netlab-node"), "-tags=netlab", "./integration/netlab")
	// The sidecar starts <dir>/tor; the node takes the tor role by that name.
	if err := os.MkdirAll(filepath.Join(lab.bin, "tor"), 0o755); err != nil {
		t.Fatal(err)
	}
	build(filepath.Join(lab.bin, "tor", "tor"), "-tags=netlab", "./integration/netlab")
	t.Logf("binários linux/%s compilados em %s", arch, time.Since(started).Round(100*time.Millisecond))

	_, _ = lab.composeRun("down", "--volumes", "--remove-orphans")
	t.Cleanup(lab.stop)
	started = time.Now()
	if out, err := lab.composeRun("up", "--detach", "--build", "--wait", "--quiet-pull"); err != nil {
		t.Fatalf("docker compose up: %v\n%s", err, out)
	}
	t.Logf("laboratório de pé em %s", time.Since(started).Round(100*time.Millisecond))
	return lab
}

func (lab *netLab) stop() {
	if out, err := lab.composeRun("logs", "--no-color", "--timestamps"); err == nil {
		_ = os.WriteFile(filepath.Join(lab.logs, "compose.log"), []byte(out), 0o644)
	}
	if os.Getenv("NETLAB_KEEP") == "1" {
		lab.t.Logf("NETLAB_KEEP=1: laboratório mantido; limpe com docker compose -p %s down --volumes --rmi local", netLabProject)
		return
	}
	if out, err := lab.composeRun("down", "--volumes", "--remove-orphans", "--rmi", "local", "--timeout", "5"); err != nil {
		lab.t.Logf("docker compose down: %v\n%s", err, out)
	}
}

func (lab *netLab) mustRun(t *testing.T, name string, args ...string) string {
	t.Helper()
	command := exec.Command(name, args...)
	command.Env = lab.env
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}

func (lab *netLab) composeArgs(args ...string) []string {
	return append([]string{"compose", "--project-name", netLabProject, "--file", lab.compose}, args...)
}

func (lab *netLab) composeRun(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "docker", lab.composeArgs(args...)...)
	command.Env = lab.env
	out, err := command.CombinedOutput()
	return string(out), err
}

// exec runs a short command inside service and fails the test on error.
func (lab *netLab) exec(t *testing.T, service string, args ...string) string {
	t.Helper()
	out, err := lab.composeRun(append([]string{"exec", "-T", service}, args...)...)
	if err != nil {
		t.Fatalf("exec %s %v: %v\n%s", service, args, err, out)
	}
	return out
}

// setRouter changes the NAT mode, cone or symmetric, and whether UDP passes
// through a router, flushing its connection tracking.
func (lab *netLab) setRouter(t *testing.T, router, mode string, udpBlocked bool) {
	t.Helper()
	udp := "open"
	if udpBlocked {
		udp = "blocked"
	}
	t.Logf("%s: %s", router, strings.TrimSpace(lab.exec(t, router, "netlab-router", "apply", mode, udp)))
}

// logFile opens a log for a process of the laboratory.
func (lab *netLab) logFile(t *testing.T, name string) *os.File {
	t.Helper()
	lab.mu.Lock()
	lab.sequence++
	sequence := lab.sequence
	lab.mu.Unlock()
	file, err := os.Create(filepath.Join(lab.logs, fmt.Sprintf("%02d-%s.log", sequence, name)))
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// lineProcess is a process inside a container that speaks JSON lines over the
// stdio of docker compose exec.
type lineProcess struct {
	name    string
	command *exec.Cmd
	stdin   io.WriteCloser
	log     *os.File
	exited  chan struct{}

	mu      sync.Mutex
	lines   []timedLine
	changed chan struct{}
}

type timedLine struct {
	at  time.Time
	raw json.RawMessage
}

func (lab *netLab) startProcess(t *testing.T, name, service string, args ...string) *lineProcess {
	t.Helper()
	process := &lineProcess{name: name, log: lab.logFile(t, name), exited: make(chan struct{}), changed: make(chan struct{})}
	process.command = exec.Command("docker", lab.composeArgs(append([]string{"exec", "-T", service}, args...)...)...)
	process.command.Env = lab.env
	process.command.Stderr = process.log
	var err error
	if process.stdin, err = process.command.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stdout, err := process.command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := process.command.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64<<10), 4<<20)
		for scanner.Scan() {
			raw := append(json.RawMessage(nil), scanner.Bytes()...)
			fmt.Fprintf(process.log, "%s stdout %s\n", time.Now().Format("15:04:05.000"), raw)
			if !json.Valid(raw) {
				continue
			}
			process.mu.Lock()
			process.lines = append(process.lines, timedLine{at: time.Now(), raw: raw})
			close(process.changed)
			process.changed = make(chan struct{})
			process.mu.Unlock()
		}
		_ = process.command.Wait()
		process.mu.Lock()
		close(process.exited)
		close(process.changed)
		process.changed = make(chan struct{})
		process.mu.Unlock()
	}()
	return process
}

func (process *lineProcess) send(t *testing.T, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := process.stdin.Write(append(raw, '\n')); err != nil {
		t.Fatalf("%s stdin: %v", process.name, err)
	}
}

func (process *lineProcess) mark() int {
	process.mu.Lock()
	defer process.mu.Unlock()
	return len(process.lines)
}

// wait returns the first line at or after from accepted by match, its index
// and the time it arrived.
func (process *lineProcess) wait(t *testing.T, from int, timeout time.Duration, what string, match func(json.RawMessage) bool) (json.RawMessage, int, time.Time) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		process.mu.Lock()
		lines, changed := process.lines, process.changed
		process.mu.Unlock()
		for index := from; index < len(lines); index++ {
			if match(lines[index].raw) {
				return lines[index].raw, index, lines[index].at
			}
		}
		select {
		case <-process.exited:
			t.Fatalf("%s terminou antes de %s; log em %s:\n%s", process.name, what, process.log.Name(), tailFile(process.log.Name(), 40))
		default:
		}
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatalf("%s: %s não chegou em %s; log em %s:\n%s", process.name, what, timeout, process.log.Name(), tailFile(process.log.Name(), 40))
		}
	}
}

// find reports whether any line at or after from matches.
func (process *lineProcess) find(from int, match func(json.RawMessage) bool) (json.RawMessage, bool) {
	process.mu.Lock()
	defer process.mu.Unlock()
	for _, line := range process.lines[min(from, len(process.lines)):] {
		if match(line.raw) {
			return line.raw, true
		}
	}
	return nil, false
}

func (process *lineProcess) close() {
	_ = process.stdin.Close()
	select {
	case <-process.exited:
	case <-time.After(30 * time.Second):
		_ = process.command.Process.Kill()
		<-process.exited
	}
	_ = process.log.Close()
}

func tailFile(path string, lines int) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err.Error()
	}
	all := strings.Split(strings.TrimSpace(string(raw)), "\n")
	return strings.Join(all[max(0, len(all)-lines):], "\n")
}

func field(raw json.RawMessage, name string) string {
	var fields map[string]any
	if json.Unmarshal(raw, &fields) != nil {
		return ""
	}
	value, ok := fields[name]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// labDesktop is the supervisor stand-in in the desktop container with the
// real sidecar behind it.
type labDesktop struct {
	*lineProcess
	lab       *netLab
	bridgeURL string
	staticDir string
	mu        sync.Mutex
	next      uint64
}

type netStatus struct {
	State   string `json:"state"`
	Desktop struct {
		ID        string `json:"id"`
		PublicKey string `json:"publicKey"`
	} `json:"desktop"`
	Direct struct {
		Port       int `json:"port"`
		Candidates []struct {
			Kind string `json:"kind"`
			Addr string `json:"addr"`
		} `json:"candidates"`
		STUN struct {
			State string `json:"state"`
			Addr  string `json:"addr"`
		} `json:"stun"`
	} `json:"direct"`
	Tor struct {
		State     string `json:"state"`
		Onion     string `json:"onion"`
		Published bool   `json:"published"`
	} `json:"tor"`
	Sessions struct {
		Direct int `json:"direct"`
		Tor    int `json:"tor"`
	} `json:"sessions"`
}

func (lab *netLab) startDesktop(t *testing.T) *labDesktop {
	t.Helper()
	desktop := &labDesktop{lab: lab, lineProcess: lab.startProcess(t, "desktop", "desktop", "/opt/netlab/netlab-node", "desktop")}
	ready, _, _ := desktop.wait(t, 0, netLabEventWait, "netlab ready", func(raw json.RawMessage) bool { return field(raw, "netlab") == "ready" })
	desktop.bridgeURL, desktop.staticDir = field(ready, "bridgeUrl"), field(ready, "staticDir")
	desktop.handshake(t, 0)
	return desktop
}

// handshake answers the hello event of the sidecar started after from.
func (desktop *labDesktop) handshake(t *testing.T, from int) {
	t.Helper()
	desktop.wait(t, from, netLabEventWait, "hello do sidecar", func(raw json.RawMessage) bool { return field(raw, "event") == "hello" })
	desktop.call(t, "hello", map[string]any{"protocol": 1}, nil)
}

type rpcFailure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// request sends one command and returns its result or its error.
func (desktop *labDesktop) request(t *testing.T, command string, args any) (json.RawMessage, *rpcFailure) {
	t.Helper()
	desktop.mu.Lock()
	desktop.next++
	id := desktop.next
	desktop.mu.Unlock()
	from := desktop.mark()
	desktop.send(t, map[string]any{"id": id, "cmd": command, "args": args})
	raw, _, _ := desktop.wait(t, from, netLabCallTimeout, "resposta de "+command, func(raw json.RawMessage) bool {
		var frame struct {
			ID    uint64 `json:"id"`
			Event string `json:"event"`
		}
		return json.Unmarshal(raw, &frame) == nil && frame.ID == id && frame.Event == ""
	})
	var response struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *rpcFailure     `json:"error"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("resposta de %s: %v", command, err)
	}
	if !response.OK {
		return nil, response.Error
	}
	return response.Result, nil
}

func (desktop *labDesktop) call(t *testing.T, command string, args any, result any) {
	t.Helper()
	raw, failure := desktop.request(t, command, args)
	if failure != nil {
		t.Fatalf("%s falhou: %+v", command, failure)
	}
	if result != nil {
		if err := json.Unmarshal(raw, result); err != nil {
			t.Fatalf("resultado de %s %s: %v", command, raw, err)
		}
	}
}

// startNetwork calls net.start as the desktop interface does, with the
// laboratory STUN server, and waits until the onion is published at the relay.
func (desktop *labDesktop) startNetwork(t *testing.T) netStatus {
	t.Helper()
	from := desktop.mark()
	var status netStatus
	desktop.call(t, "net.start", map[string]any{
		"desktopName": netLabDesktopName, "requireApproval": false, "stun": []string{netLabSTUN},
		"staticDir": desktop.staticDir, "bridgeUrl": desktop.bridgeURL, "proxySecret": netLabProxySecret,
	}, &status)
	if status.State != "ready" && status.State != "degraded" {
		t.Fatalf("net.start: %+v", status)
	}
	if !status.Tor.Published {
		desktop.waitEvent(t, from, "tor.state", "onion publicado", func(data json.RawMessage) bool { return field(data, "published") == "true" })
	}
	desktop.call(t, "net.status", map[string]any{}, &status)
	return status
}

// setApproval turns the four digit approval on or off through net.start,
// which applies it to the running network.
func (desktop *labDesktop) setApproval(t *testing.T, required bool) {
	t.Helper()
	desktop.call(t, "net.start", map[string]any{
		"desktopName": netLabDesktopName, "requireApproval": required, "stun": []string{netLabSTUN},
		"staticDir": desktop.staticDir, "bridgeUrl": desktop.bridgeURL, "proxySecret": netLabProxySecret,
	}, nil)
}

// waitEvent waits for a sidecar event named name whose data matches.
func (desktop *labDesktop) waitEvent(t *testing.T, from int, name, what string, match func(json.RawMessage) bool) (json.RawMessage, int, time.Time) {
	t.Helper()
	var data json.RawMessage
	_, index, at := desktop.wait(t, from, netLabEventWait, what, func(raw json.RawMessage) bool {
		var frame struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &frame) != nil || frame.Event != name || (match != nil && !match(frame.Data)) {
			return false
		}
		data = frame.Data
		return true
	})
	return data, index, at
}

// findEvent reports an already received sidecar event.
func (desktop *labDesktop) findEvent(from int, name string, match func(json.RawMessage) bool) (json.RawMessage, bool) {
	var data json.RawMessage
	_, found := desktop.find(from, func(raw json.RawMessage) bool {
		var frame struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &frame) != nil || frame.Event != name || (match != nil && !match(frame.Data)) {
			return false
		}
		data = frame.Data
		return true
	})
	return data, found
}

// restartSidecar signals the sidecar, TERM like the app quitting or KILL like
// a crash, lets the stand-in start it again and runs the supervisor startup:
// hello and net.start with the same arguments.
func (desktop *labDesktop) restartSidecar(t *testing.T, signal string) (netStatus, time.Duration) {
	t.Helper()
	from := desktop.mark()
	started := time.Now()
	desktop.send(t, map[string]any{"netlab": "restart", "signal": signal})
	desktop.wait(t, from, netLabEventWait, "reinício do sidecar", func(raw json.RawMessage) bool {
		return field(raw, "netlab") == "restart" && field(raw, "ok") == "true"
	})
	desktop.handshake(t, from)
	status := desktop.startNetwork(t)
	return status, time.Since(started)
}

// pairBegin returns the CIALAI2 payload of a new pairing session.
func (desktop *labDesktop) pairBegin(t *testing.T) string {
	t.Helper()
	var begun struct {
		PairID  string `json:"pairId"`
		Payload string `json:"payload"`
		Rotate  int    `json:"rotateAfterSeconds"`
	}
	desktop.call(t, "pair.begin", map[string]any{"ttlSeconds": 600}, &begun)
	if begun.Rotate != 90 || !strings.HasPrefix(begun.Payload, "CIALAI2.") {
		t.Fatalf("pair.begin: %+v", begun)
	}
	return begun.Payload
}

// labPhone is a headless phone around the mobile package.
type labPhone struct {
	*lineProcess
	lab   *netLab
	state string
	mu    sync.Mutex
	next  uint64
}

type phoneReply struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	MS     int64           `json:"ms"`
}

// code is the phone API error code of a failed reply.
func (reply phoneReply) code() string {
	code, _, _ := strings.Cut(reply.Error, ": ")
	return code
}

// startPhone starts a phone in service with its own state directory, which a
// later phone of the same name reuses like an app restart.
func (lab *netLab) startPhone(t *testing.T, service, name string) *labPhone {
	t.Helper()
	state := "/tmp/phones/" + name
	phone := &labPhone{lab: lab, state: state, lineProcess: lab.startProcess(t, "phone-"+name, service, "/opt/netlab/netlab-node", "phone", "-state", state)}
	phone.wait(t, 0, netLabEventWait, "celular pronto", func(raw json.RawMessage) bool { return field(raw, "ready") == "true" })
	t.Cleanup(phone.close)
	return phone
}

func (phone *labPhone) request(t *testing.T, command string, args any) phoneReply {
	t.Helper()
	return phone.requestAsync(t, command, args)()
}

// requestAsync sends a command and returns the function that waits for its
// reply, so the test can act on the desktop while the phone waits.
func (phone *labPhone) requestAsync(t *testing.T, command string, args any) func() phoneReply {
	t.Helper()
	phone.mu.Lock()
	phone.next++
	id := phone.next
	phone.mu.Unlock()
	from := phone.mark()
	if args == nil {
		args = map[string]any{}
	}
	phone.send(t, map[string]any{"id": id, "cmd": command, "args": args})
	return func() phoneReply {
		t.Helper()
		raw, _, _ := phone.wait(t, from, 2*time.Minute, "resposta de "+command, func(raw json.RawMessage) bool {
			var frame struct {
				ID uint64 `json:"id"`
			}
			return json.Unmarshal(raw, &frame) == nil && frame.ID == id
		})
		var reply phoneReply
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatalf("resposta de %s: %v", command, err)
		}
		return reply
	}
}

func (phone *labPhone) must(t *testing.T, command string, args any) phoneReply {
	t.Helper()
	reply := phone.request(t, command, args)
	if !reply.OK {
		t.Fatalf("%s no celular %s falhou: %s; log:\n%s", command, phone.name, reply.Error, tailFile(phone.log.Name(), 30))
	}
	return reply
}

// waitEvent waits for a mobile listener event of kind whose payload matches.
func (phone *labPhone) waitEvent(t *testing.T, from int, kind, what string, match func(json.RawMessage) bool) (json.RawMessage, time.Time) {
	t.Helper()
	var data json.RawMessage
	_, _, at := phone.wait(t, from, netLabEventWait, what, func(raw json.RawMessage) bool {
		var frame struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &frame) != nil || frame.Event != kind || (match != nil && !match(frame.Data)) {
			return false
		}
		data = frame.Data
		return true
	})
	return data, at
}

func (phone *labPhone) findEvent(from int, kind string, match func(json.RawMessage) bool) (json.RawMessage, bool) {
	var data json.RawMessage
	_, found := phone.find(from, func(raw json.RawMessage) bool {
		var frame struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &frame) != nil || frame.Event != kind || (match != nil && !match(frame.Data)) {
			return false
		}
		data = frame.Data
		return true
	})
	return data, found
}

type pairResult struct {
	DesktopID string `json:"desktopId"`
	DeviceID  string `json:"deviceId"`
	Token     string `json:"token"`
	Transport string `json:"transport"`
	elapsed   time.Duration
}

type connectResult struct {
	Transport string `json:"transport"`
	Path      string `json:"path"`
	Elapsed   int64  `json:"elapsedMs"`
}

// pair runs a QR from pair.begin through the phone and returns the result.
func (phone *labPhone) pair(t *testing.T, desktop *labDesktop) pairResult {
	t.Helper()
	return phone.pairPayload(t, desktop.pairBegin(t))
}

// pairPayload pairs with a QR payload the test already holds.
func (phone *labPhone) pairPayload(t *testing.T, payload string) pairResult {
	t.Helper()
	reply := phone.must(t, "pair", map[string]any{"payload": payload})
	var result pairResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatal(err)
	}
	result.elapsed = time.Duration(reply.MS) * time.Millisecond
	return result
}

func (phone *labPhone) connect(t *testing.T, desktopID string) connectResult {
	t.Helper()
	reply := phone.must(t, "connect", map[string]any{"desktopId": desktopID})
	var result connectResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

// open creates the loopback origin with the token and claims the page cookie.
func (phone *labPhone) open(t *testing.T, paired pairResult) {
	t.Helper()
	phone.must(t, "open", map[string]any{"desktopId": paired.DesktopID, "token": paired.Token})
}

// echo opens a WebSocket through the proxy and returns the round trip time.
func (phone *labPhone) echo(t *testing.T, message string) time.Duration {
	t.Helper()
	return time.Duration(phone.must(t, "echo", map[string]any{"message": message}).MS) * time.Millisecond
}

// echoUntil repeats echo until it works, as a page reconnecting, and returns
// the attempts and the time since start.
func (phone *labPhone) echoUntil(t *testing.T, since time.Time, limit time.Duration) (int, time.Duration) {
	t.Helper()
	for attempt := 1; ; attempt++ {
		reply := phone.request(t, "echo", map[string]any{"message": fmt.Sprintf("tentativa %d", attempt)})
		if reply.OK {
			return attempt, time.Since(since)
		}
		if time.Since(since) > limit {
			t.Fatalf("o celular %s não voltou a alcançar o computador em %s: %s; log:\n%s", phone.name, limit, reply.Error, tailFile(phone.log.Name(), 40))
		}
		time.Sleep(time.Second)
	}
}

func (phone *labPhone) status(t *testing.T) (state, path, transport string) {
	t.Helper()
	var status struct {
		State  string `json:"state"`
		Active *struct {
			Transport string `json:"transport"`
			Path      string `json:"path"`
		} `json:"active"`
	}
	if err := json.Unmarshal(phone.must(t, "status", nil).Result, &status); err != nil {
		t.Fatal(err)
	}
	if status.Active == nil {
		return status.State, "", ""
	}
	return status.State, status.Active.Path, status.Active.Transport
}

// scenarioResult is one line of the laboratory report.
type scenarioResult struct {
	Name   string   `json:"name"`
	Passed bool     `json:"passed"`
	Path   string   `json:"path"`
	Total  string   `json:"total"`
	Steps  []step   `json:"steps"`
	Notes  []string `json:"notes,omitempty"`
	start  time.Time
}

type step struct {
	Name   string `json:"name"`
	Millis int64  `json:"ms"`
	Detail string `json:"detail,omitempty"`
}

func (lab *netLab) scenario(t *testing.T, name string) *scenarioResult {
	t.Helper()
	result := &scenarioResult{Name: name, start: time.Now()}
	lab.mu.Lock()
	lab.results = append(lab.results, result)
	lab.mu.Unlock()
	t.Cleanup(func() {
		result.Passed = !t.Failed()
		result.Total = time.Since(result.start).Round(100 * time.Millisecond).String()
	})
	return result
}

func (result *scenarioResult) step(t *testing.T, name string, elapsed time.Duration, detail string) {
	t.Helper()
	result.Steps = append(result.Steps, step{Name: name, Millis: elapsed.Milliseconds(), Detail: detail})
	t.Logf("%s: %s em %s %s", result.Name, name, elapsed.Round(time.Millisecond), detail)
}

func (result *scenarioResult) note(t *testing.T, format string, args ...any) {
	t.Helper()
	note := fmt.Sprintf(format, args...)
	result.Notes = append(result.Notes, note)
	t.Logf("%s: %s", result.Name, note)
}

// report logs the table of scenarios and writes report.json beside the logs.
func (lab *netLab) report(t *testing.T) {
	lab.mu.Lock()
	defer lab.mu.Unlock()
	var table bytes.Buffer
	fmt.Fprintf(&table, "laboratório de NAT e reserva em %s/%s, Docker %s\n", runtime.GOOS, runtime.GOARCH, strings.TrimSpace(lab.mustRun(t, "docker", "version", "--format", "{{.Server.Version}}")))
	for _, result := range lab.results {
		verdict := "falhou"
		if result.Passed {
			verdict = "passou"
		}
		fmt.Fprintf(&table, "%-26s %-7s caminho %-22s total %s\n", result.Name, verdict, result.Path, result.Total)
		for _, item := range result.Steps {
			fmt.Fprintf(&table, "    %-38s %6d ms %s\n", item.Name, item.Millis, item.Detail)
		}
		for _, note := range result.Notes {
			fmt.Fprintf(&table, "    nota: %s\n", note)
		}
	}
	t.Log("\n" + table.String())
	raw, _ := json.MarshalIndent(lab.results, "", "  ")
	_ = os.WriteFile(filepath.Join(lab.logs, "report.json"), raw, 0o644)
	_ = os.WriteFile(filepath.Join(lab.logs, "report.txt"), table.Bytes(), 0o644)
}
