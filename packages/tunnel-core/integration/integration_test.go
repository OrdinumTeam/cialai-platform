// SPDX-License-Identifier: Apache-2.0
//go:build integration

// Package integration_test drives the real desktop sidecar, a phone tsnet node
// with the loopback proxy and Headscale 0.29.3 in Docker, end to end, as
// described in document 06. It never uses a server owned by the user.
package integration_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/logx"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/node"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/pairing"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/proxy"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/sidecar"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/statedir"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/testutil"
)

const proxySecret = "integration-proxy-secret-7f3c9a1e5b"

func TestDesktopPairsPhoneThroughHeadscale(t *testing.T) {
	t.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	t.Setenv("TS_LOGS_DIR", t.TempDir())

	hs := testutil.StartHeadscale(t)
	aliceID := hs.CreateUser("alice")
	bobID := hs.CreateUser("bob")
	bridge := testutil.StartBridge(t)
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "mobile.html"), []byte("<!doctype html><title>Cialai</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	desktopID := "d_" + base64.RawURLEncoding.EncodeToString(randomBytes(t, 16))
	side := startSidecar(t)

	t.Log("desktop joins Headscale and opens the edge through the sidecar protocol")
	var configured struct {
		Health struct {
			OK bool `json:"ok"`
		} `json:"health"`
	}
	side.call("control.configure", map[string]any{"url": hs.URL, "apiKey": hs.APIKey()}, &configured)
	if !configured.Health.OK {
		t.Fatal("control.configure did not report a healthy server")
	}
	var desktop node.Status
	side.call("node.up", map[string]any{"controlUrl": hs.URL, "userId": aliceID, "userName": "alice", "hostname": "alice-desktop"}, &desktop)
	if desktop.State != node.Running || desktop.NodeKey == "" || desktop.IP4 == "" {
		t.Fatalf("desktop node is not running: state %q", desktop.State)
	}
	side.call("edge.serve", map[string]any{
		"port": 4740, "staticDir": staticDir, "bridgeUrl": bridge.URL, "proxySecret": proxySecret,
		"desktop": map[string]string{"id": desktopID, "name": "Mac de Alice"},
	}, nil)

	t.Log("phone reads the QR, enrolls with its key and pairs through the tunnel")
	var begun struct {
		PairID  string `json:"pairId"`
		Payload string `json:"payload"`
	}
	side.call("pair.begin", map[string]any{"ttlSeconds": 600}, &begun)
	payload, err := pairing.Decode(begun.Payload, true)
	if err != nil {
		t.Fatalf("pairing payload rejected: %s", pairing.Code(err))
	}
	if payload.PairID != begun.PairID || payload.UserID != aliceID || payload.AuthKey == nil || payload.Desktop.NodeKey != desktop.NodeKey || payload.Desktop.Port != 4740 {
		t.Fatal("pairing payload does not describe the running desktop")
	}
	phone, phoneStatus := upNode(t, payload.ControlURL, payload.UserID, payload.UserName, "alice-phone", *payload.AuthKey)
	peer := waitPeer(t, phone, payload.Desktop.NodeKey, 30*time.Second)
	tunnel := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: phone.Dial}}
	base := "http://" + net.JoinHostPort(peer.IP4, strconv.Itoa(payload.Desktop.Port))

	var health struct {
		Service string `json:"service"`
		Desktop struct {
			ID string `json:"id"`
		} `json:"desktop"`
	}
	getJSON(t, tunnel, base+"/api/health", &health)
	if health.Service != "cialai" || health.Desktop.ID != desktopID {
		t.Fatal("edge health does not identify the Cialai desktop")
	}

	pairBody := map[string]any{"v": 1, "pairId": payload.PairID, "secret": payload.Secret, "device": map[string]string{
		"name": "iPhone de Alice", "model": "iPhone16,1", "platform": "ios", "app": "1.0.0", "nodeKey": phoneStatus.NodeKey,
	}}
	status, body := postJSON(t, tunnel, base+"/pair", pairBody)
	if status != http.StatusOK {
		t.Fatalf("pairing failed: HTTP %d %s", status, problemCode(body))
	}
	var paired struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
	}
	if err := json.Unmarshal(body, &paired); err != nil || paired.DeviceID == "" || !strings.HasPrefix(paired.Token, "cdt1.") {
		t.Fatal("pairing response lacks the device credential")
	}
	side.waitEvent(t, "pair.completed", func(data json.RawMessage) bool { return strings.Contains(string(data), payload.PairID) }, 5*time.Second)

	t.Log("the same QR cannot be replayed at the edge or at Headscale")
	if status, body := postJSON(t, tunnel, base+"/pair", pairBody); status != http.StatusGone || problemCode(body) != "pair_consumed" {
		t.Fatalf("replayed pairing was not consumed: HTTP %d %s", status, problemCode(body))
	}
	thief := node.NewTSNetManager(discard, discard)
	thiefCtx, cancelThief := context.WithTimeout(context.Background(), 20*time.Second)
	_, thiefErr := thief.Up(thiefCtx, node.Config{StateDir: t.TempDir(), ControlURL: payload.ControlURL, UserID: payload.UserID, UserName: payload.UserName, Hostname: "alice-replay", AuthKey: *payload.AuthKey})
	cancelThief()
	_ = thief.Down()
	if thiefErr == nil {
		t.Fatal("a consumed enrollment key joined the tailnet again")
	}

	t.Log("an expired pairing session is refused")
	var short struct {
		Payload string `json:"payload"`
	}
	side.call("pair.begin", map[string]any{"ttlSeconds": 1}, &short)
	time.Sleep(2 * time.Second)
	expired, err := pairing.Decode(short.Payload, true)
	if err != nil {
		t.Fatalf("short pairing payload rejected: %s", pairing.Code(err))
	}
	expiredBody := map[string]any{"v": 1, "pairId": expired.PairID, "secret": expired.Secret, "device": pairBody["device"]}
	if status, body := postJSON(t, tunnel, base+"/pair", expiredBody); status != http.StatusGone || problemCode(body) != "pair_expired" {
		t.Fatalf("expired pairing was accepted or misclassified: HTTP %d %s", status, problemCode(body))
	}

	t.Log("WebSocket frames cross proxy, tunnel, edge and bridge")
	localProxy, err := proxy.New(proxy.Config{Tunnel: phone, DesktopID: payload.Desktop.ID, DesktopNodeKey: payload.Desktop.NodeKey, DesktopPort: payload.Desktop.Port, DeviceToken: paired.Token})
	if err != nil {
		t.Fatal(err)
	}
	opened, err := localProxy.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = localProxy.Close(ctx)
	})
	loopback := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	origin := "http://127.0.0.1:" + strconv.Itoa(opened.Port)
	if status := getStatus(t, loopback, origin+"/"); status != http.StatusForbidden {
		t.Fatalf("proxy served a request without the nonce cookie: HTTP %d", status)
	}
	claim, err := loopback.Get(opened.URL)
	if err != nil {
		t.Fatal(err)
	}
	claim.Body.Close()
	var cookie *http.Cookie
	for _, candidate := range claim.Cookies() {
		if candidate.Name == proxy.CookieName {
			cookie = candidate
		}
	}
	if claim.StatusCode != http.StatusFound || cookie == nil || !cookie.HttpOnly {
		t.Fatalf("nonce was not exchanged for the proxy cookie: HTTP %d", claim.StatusCode)
	}
	dialCtx, cancelDial := context.WithTimeout(context.Background(), 20*time.Second)
	socket, _, err := websocket.Dial(dialCtx, "ws://127.0.0.1:"+strconv.Itoa(opened.Port)+"/pty", &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": []string{proxy.CookieName + "=" + cookie.Value}},
	})
	cancelDial()
	if err != nil {
		t.Fatalf("WebSocket through the proxy failed: %v", err)
	}
	t.Cleanup(func() { _ = socket.CloseNow() })
	socket.SetReadLimit(4 << 20)
	echo(t, socket, websocket.MessageText, []byte("cialai integration"))
	echo(t, socket, websocket.MessageBinary, []byte{0, 1, 2, 253, 254, 255})
	echo(t, socket, websocket.MessageBinary, randomBytes(t, 1<<20))
	upgrades := bridge.Upgrades()
	if len(upgrades) == 0 {
		t.Fatal("bridge saw no upgrade")
	}
	seen := upgrades[len(upgrades)-1]
	if seen.ProxySecret != proxySecret || seen.DeviceID != paired.DeviceID || seen.NodeKey != phoneStatus.NodeKey {
		t.Fatal("bridge did not receive the trusted edge identity")
	}
	if seen.Authorization != "" || seen.Cookie != "" {
		t.Fatal("device credentials leaked to the bridge")
	}

	t.Log("another user cannot see or reach the desktop")
	bobKey := hs.CreatePreAuthKey(bobID)
	bob, _ := upNode(t, hs.URL, bobID, "bob", "bob-phone", bobKey.Key)
	for range 6 {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _ = bob.Status(ctx)
		cancel()
		if _, visible := bob.Peer(desktop.NodeKey); visible {
			t.Fatal("bob can see alice's desktop")
		}
		time.Sleep(500 * time.Millisecond)
	}
	bobCtx, cancelBob := context.WithTimeout(context.Background(), 3*time.Second)
	if connection, err := bob.Dial(bobCtx, "tcp", net.JoinHostPort(desktop.IP4, "4740")); err == nil {
		connection.Close()
		cancelBob()
		t.Fatal("bob reached alice's desktop edge")
	}
	cancelBob()

	t.Log("revocation closes the socket fast and removes the phone from Headscale")
	type readResult struct {
		err error
		at  time.Time
	}
	closed := make(chan readResult, 1)
	go func() {
		_, _, err := socket.Read(context.Background())
		closed <- readResult{err: err, at: time.Now()}
	}()
	started := time.Now()
	side.call("devices.revoke", map[string]any{"deviceId": paired.DeviceID, "network": true}, nil)
	select {
	case result := <-closed:
		if result.err == nil {
			t.Fatal("revoked socket delivered a frame instead of closing")
		}
		if elapsed := result.at.Sub(started); elapsed > 2*time.Second {
			t.Fatalf("revoked socket closed after %s", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revoked socket stayed open for more than 2 seconds")
	}
	side.waitEvent(t, "devices.changed", func(data json.RawMessage) bool {
		return strings.Contains(string(data), paired.DeviceID) && strings.Contains(string(data), `"revoked":true`)
	}, 5*time.Second)
	deadline := time.Now().Add(15 * time.Second)
	for nodePresent(hs.Nodes(), phoneStatus.NodeKey) {
		if time.Now().After(deadline) {
			t.Fatal("revoked phone is still registered in Headscale")
		}
		time.Sleep(500 * time.Millisecond)
	}

	t.Log("API key rotation expires the previous prefix")
	previous := hs.APIKey()
	var rotated struct {
		APIKey string `json:"apiKey"`
		Prefix string `json:"prefix"`
	}
	side.call("control.apikey.rotate", map[string]any{"days": 1}, &rotated)
	if !strings.HasPrefix(rotated.APIKey, "hskey-api-") || rotated.APIKey == previous {
		t.Fatal("rotation did not return a new API key")
	}
	side.call("control.apikey.expireOld", map[string]any{"prefix": apiKeyPrefix(previous)}, nil)
	if status := hs.Status(previous, http.MethodGet, "/api/v1/user"); status != http.StatusUnauthorized && status != http.StatusForbidden {
		t.Fatalf("expired API key still works: HTTP %d", status)
	}
	if status := hs.Status(rotated.APIKey, http.MethodGet, "/api/v1/user"); status != http.StatusOK {
		t.Fatalf("rotated API key was rejected: HTTP %d", status)
	}
	hs.SetAPIKey(rotated.APIKey)
	side.call("control.users.list", map[string]any{}, nil)
}

type rpcFrame struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code string `json:"code"`
	} `json:"error"`
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

type sidecarClient struct {
	t       *testing.T
	input   *io.PipeWriter
	mu      sync.Mutex
	next    uint64
	pending map[uint64]chan rpcFrame
	events  chan rpcFrame
	exited  chan int
}

func startSidecar(t *testing.T) *sidecarClient {
	t.Helper()
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	client := &sidecarClient{t: t, input: inputWriter, pending: map[uint64]chan rpcFrame{}, events: make(chan rpcFrame, 512), exited: make(chan int, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		code := sidecar.Serve(ctx, sidecar.Options{
			Paths: paths, Input: inputReader, Output: outputWriter, Logger: logx.New(io.Discard, 500),
			HandshakeTimeout: 10 * time.Second, AllowLoopbackHTTP: true,
		})
		_ = outputWriter.Close()
		client.exited <- code
	}()
	hello := make(chan struct{})
	go client.read(outputReader, hello)
	select {
	case <-hello:
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("sidecar did not send hello")
	}
	var negotiated struct {
		Protocol int `json:"protocol"`
	}
	client.call("hello", map[string]any{"protocol": 1}, &negotiated)
	if negotiated.Protocol != 1 {
		cancel()
		t.Fatal("sidecar negotiated an unexpected protocol")
	}
	t.Cleanup(func() {
		_ = client.request("shutdown", map[string]any{}, 10*time.Second)
		_ = inputWriter.Close()
		select {
		case <-client.exited:
		case <-time.After(20 * time.Second):
			t.Error("sidecar did not exit after shutdown")
		}
		cancel()
	})
	return client
}

func (client *sidecarClient) read(output io.Reader, hello chan<- struct{}) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64<<10), 512<<10)
	waitingHello := true
	for scanner.Scan() {
		var frame rpcFrame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		if frame.Event != "" {
			if waitingHello && frame.Event == "hello" {
				waitingHello = false
				close(hello)
				continue
			}
			select {
			case client.events <- frame:
			default:
			}
			continue
		}
		client.mu.Lock()
		reply := client.pending[frame.ID]
		delete(client.pending, frame.ID)
		client.mu.Unlock()
		if reply != nil {
			reply <- frame
		}
	}
}

func (client *sidecarClient) request(command string, args any, timeout time.Duration) rpcFrame {
	client.mu.Lock()
	client.next++
	id := client.next
	reply := make(chan rpcFrame, 1)
	client.pending[id] = reply
	client.mu.Unlock()
	line, err := json.Marshal(map[string]any{"id": id, "cmd": command, "args": args})
	if err != nil {
		return rpcFrame{}
	}
	written := make(chan error, 1)
	go func() {
		_, err := client.input.Write(append(line, '\n'))
		written <- err
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-written:
		if err != nil {
			return rpcFrame{}
		}
	case <-timer.C:
		return rpcFrame{}
	}
	select {
	case frame := <-reply:
		return frame
	case <-timer.C:
		return rpcFrame{}
	}
}

func (client *sidecarClient) call(command string, args any, result any) {
	client.t.Helper()
	frame := client.request(command, args, 90*time.Second)
	if frame.ID == 0 {
		client.t.Fatalf("sidecar command %s timed out", command)
	}
	if !frame.OK {
		code := "unknown"
		if frame.Error != nil {
			code = frame.Error.Code
		}
		client.t.Fatalf("sidecar command %s failed with %s", command, code)
	}
	if result != nil && json.Unmarshal(frame.Result, result) != nil {
		client.t.Fatalf("sidecar command %s returned an unexpected shape", command)
	}
}

func (client *sidecarClient) waitEvent(t *testing.T, name string, match func(json.RawMessage) bool, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame := <-client.events:
			if frame.Event == name && match(frame.Data) {
				return
			}
		case <-deadline:
			t.Fatalf("sidecar event %s not observed", name)
		}
	}
}

func discard(string, ...any) {}

func upNode(t *testing.T, controlURL, userID, userName, hostname, authKey string) (*node.Manager, node.Status) {
	t.Helper()
	manager := node.NewTSNetManager(discard, discard)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	status, err := manager.Up(ctx, node.Config{StateDir: t.TempDir(), ControlURL: controlURL, UserID: userID, UserName: userName, Hostname: hostname, AuthKey: authKey})
	if err != nil {
		t.Fatalf("tsnet startup failed for %s; details withheld to protect enrollment data", hostname)
	}
	t.Cleanup(func() { _ = manager.Down() })
	return manager, status
}

func waitPeer(t *testing.T, manager *node.Manager, nodeKey string, timeout time.Duration) node.Peer {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _ = manager.Status(ctx)
		cancel()
		if peer, ok := manager.Peer(nodeKey); ok && peer.IP4 != "" {
			return peer
		}
		if time.Now().After(deadline) {
			t.Fatal("desktop peer did not become visible to the phone")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func getJSON(t *testing.T, client *http.Client, url string, result any) {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s transport failed: %v", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(result) != nil {
		t.Fatalf("GET %s returned HTTP %d or an invalid body", url, response.StatusCode)
	}
}

func getStatus(t *testing.T, client *http.Client, url string) int {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s transport failed: %v", url, err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	return response.StatusCode
}

func postJSON(t *testing.T, client *http.Client, url string, body any) (int, []byte) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Post(url, "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("POST %s transport failed: %v", url, err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, data
}

func problemCode(data []byte) string {
	var problem struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &problem)
	return problem.Error.Code
}

func echo(t *testing.T, connection *websocket.Conn, kind websocket.MessageType, payload []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := connection.Write(ctx, kind, payload); err != nil {
		t.Fatalf("WebSocket write of %d bytes failed: %v", len(payload), err)
	}
	gotKind, got, err := connection.Read(ctx)
	if err != nil || gotKind != kind || !bytes.Equal(got, payload) {
		t.Fatalf("WebSocket echo of %d bytes did not round trip", len(payload))
	}
}

func randomBytes(t *testing.T, size int) []byte {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	return data
}

func nodePresent(nodes []testutil.Node, nodeKey string) bool {
	for _, candidate := range nodes {
		if candidate.NodeKey == nodeKey {
			return true
		}
	}
	return false
}

func apiKeyPrefix(apiKey string) string {
	const marker = "hskey-api-"
	remainder := strings.TrimPrefix(apiKey, marker)
	if separator := strings.IndexByte(remainder, '-'); separator > 0 {
		return marker + remainder[:separator]
	}
	return fmt.Sprintf("%s%.12s", marker, remainder)
}
