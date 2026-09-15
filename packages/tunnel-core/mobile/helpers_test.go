// SPDX-License-Identifier: Apache-2.0
package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
)

const eventTimeout = 15 * time.Second

type recordedEvent struct {
	Kind    string
	Raw     string
	Payload map[string]any
}

// recorder is the native listener of the tests.
type recorder struct {
	mu     sync.Mutex
	events []recordedEvent
}

func (listener *recorder) OnEvent(kind, payload string) {
	var decoded map[string]any
	_ = json.Unmarshal([]byte(payload), &decoded)
	listener.mu.Lock()
	listener.events = append(listener.events, recordedEvent{Kind: kind, Raw: payload, Payload: decoded})
	listener.mu.Unlock()
}

func (listener *recorder) mark() int {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return len(listener.events)
}

func (listener *recorder) since(mark int) []recordedEvent {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return append([]recordedEvent(nil), listener.events[mark:]...)
}

func (listener *recorder) kinds(mark int, kind string) []map[string]any {
	var payloads []map[string]any
	for _, event := range listener.since(mark) {
		if event.Kind == kind {
			payloads = append(payloads, event.Payload)
		}
	}
	return payloads
}

// wait returns the first event of kind after mark whose payload matches.
func (listener *recorder) wait(t *testing.T, mark int, kind string, match func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(eventTimeout)
	for {
		for _, event := range listener.since(mark) {
			if event.Kind == kind && (match == nil || match(event.Payload)) {
				return event.Payload
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("event %s not emitted; saw %v", kind, listener.since(mark))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func field(name string, want any) func(map[string]any) bool {
	return func(payload map[string]any) bool { return payload[name] == want }
}

func newTestTunnel(t *testing.T, stateDir string, listener Listener) *Tunnel {
	t.Helper()
	tunnel, err := NewTunnel(stateDir, listener)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tunnel.Stop() })
	return tunnel
}

func decode[T any](t *testing.T, raw string) T {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return value
}

func errorCode(err error) string {
	if err == nil {
		return ""
	}
	code, _, _ := strings.Cut(err.Error(), ": ")
	return code
}

// page is the WebView: it claims the proxy cookie and opens WebSockets to the
// loopback origin.
type page struct {
	port   int
	cookie string
}

func openPage(t *testing.T, openJSON string) *page {
	t.Helper()
	opened := decode[proxy.OpenResult](t, openJSON)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(opened.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	for _, cookie := range response.Cookies() {
		if cookie.Name == proxy.CookieName {
			return &page{port: opened.Port, cookie: proxy.CookieName + "=" + cookie.Value}
		}
	}
	t.Fatalf("proxy bootstrap returned HTTP %d without the cookie", response.StatusCode)
	return nil
}

func (page *page) get(t *testing.T, path string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", page.port, path), nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", page.cookie)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(body)
}

func (page *page) dial(ctx context.Context) (*websocket.Conn, *http.Response, error) {
	origin := fmt.Sprintf("http://127.0.0.1:%d", page.port)
	return websocket.Dial(ctx, "ws://127.0.0.1:"+fmt.Sprint(page.port)+"/pty", &websocket.DialOptions{HTTPHeader: http.Header{
		"Cookie": {page.cookie},
		"Origin": {origin},
	}})
}

// echo opens a socket through the proxy and checks one round trip.
func (page *page) echo(t *testing.T, ctx context.Context, message string) *websocket.Conn {
	t.Helper()
	socket, response, err := page.dial(ctx)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("WebSocket through the proxy: HTTP %d, %v", status, err)
	}
	if response.Header.Get("X-Cialai-Token-Next") != "" {
		t.Fatal("the rotated token reached the page")
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
		t.Fatal(err)
	}
	if _, data, err := socket.Read(ctx); err != nil || string(data) != message {
		t.Fatalf("echo = %q, %v", data, err)
	}
	return socket
}

func testContext(t *testing.T, timeout time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)
	return ctx
}

// requireNoToken fails when a device token was written under root.
func requireNoToken(t *testing.T, root string, tokens ...string) {
	t.Helper()
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, token := range tokens {
			secret := token[strings.LastIndex(token, ".")+1:]
			if strings.Contains(string(raw), token) || strings.Contains(string(raw), secret) || strings.Contains(string(raw), url.QueryEscape(secret)) {
				t.Fatalf("%s holds a device token", path)
			}
		}
		if strings.Contains(string(raw), "cdt1.") {
			t.Fatalf("%s holds a device token", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
