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
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
	"github.com/Cialai/cialai/packages/tunnel-core/mobile"
)

// The phone role is a phone without interface: mobile.Tunnel as the native
// shell uses it, a WebView stand-in for the loopback proxy and a local SOCKS
// listener standing in for the in-process Tor of the apps, which forwards to
// the relay over TCP through the router of the phone network.
//
// The test drives it with one JSON request per line on stdin,
// {"id":1,"cmd":"pair","args":{...}}, and reads {"id":1,"ok":true,"result":...}
// or {"id":1,"ok":false,"error":"code: message"} with the duration in ms.
// Every event of the mobile listener is written as {"event":kind,"data":...}
// and the WebSockets kept open by hold report their end as a "socket" event.

type phoneNode struct {
	out    *lineWriter
	logger *log.Logger
	tunnel *mobile.Tunnel
	socks  string

	mu      sync.Mutex
	page    *phonePage
	sockets map[string]*websocket.Conn
}

type phonePage struct {
	port   int
	cookie string
}

type phoneRequest struct {
	ID   uint64          `json:"id"`
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args"`
}

type phoneListener struct{ out *lineWriter }

func (listener phoneListener) OnEvent(kind, payload string) {
	listener.out.json(map[string]any{"event": kind, "data": json.RawMessage(payload), "at": time.Now().UnixMilli()})
}

func runPhone(args []string) int {
	flags := flag.NewFlagSet("phone", flag.ContinueOnError)
	state := flags.String("state", "", "diretório de estado do celular")
	relay := flags.String("relay", os.Getenv("NETLAB_RELAY_SOCKS"), "entrada SOCKS da rede Tor simulada")
	if err := flags.Parse(args); err != nil || *state == "" {
		return 2
	}
	out := &lineWriter{out: os.Stdout}
	node := &phoneNode{out: out, logger: log.New(os.Stderr, "phone: ", log.LstdFlags|log.Lmicroseconds), sockets: map[string]*websocket.Conn{}}
	if *relay != "" {
		socks, err := startSOCKSForwarder(*relay, node.logger)
		if err != nil {
			node.logger.Print(err)
			return 1
		}
		node.socks = socks
	}
	if err := os.MkdirAll(*state, 0o700); err != nil {
		node.logger.Print(err)
		return 1
	}
	tunnel, err := mobile.NewTunnel(*state, phoneListener{out: out})
	if err != nil {
		node.logger.Print(err)
		return 1
	}
	node.tunnel = tunnel
	tunnel.SetLogLevel("debug")
	out.json(map[string]any{"ready": true, "version": mobile.Version(), "socks": node.socks})

	var running sync.WaitGroup
	scanner := newLineScanner(os.Stdin)
	for scanner.Scan() {
		var request phoneRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil || request.ID == 0 {
			node.logger.Printf("pedido inválido: %s", scanner.Text())
			continue
		}
		running.Add(1)
		go func() {
			defer running.Done()
			node.answer(request)
		}()
	}
	_ = tunnel.Stop()
	node.closeSockets()
	running.Wait()
	return 0
}

func (node *phoneNode) answer(request phoneRequest) {
	started := time.Now()
	result, err := node.run(request)
	reply := map[string]any{"id": request.ID, "ok": err == nil, "ms": millis(started)}
	if err != nil {
		reply["error"] = err.Error()
	} else if result != nil {
		reply["result"] = result
	}
	node.out.json(reply)
}

func (node *phoneNode) run(request phoneRequest) (any, error) {
	var args struct {
		Enabled   bool   `json:"enabled"`
		Payload   string `json:"payload"`
		DesktopID string `json:"desktopId"`
		Token     string `json:"token"`
		Message   string `json:"message"`
		Name      string `json:"name"`
		Reachable bool   `json:"reachable"`
		Path      string `json:"path"`
	}
	if len(request.Args) > 0 {
		if err := json.Unmarshal(request.Args, &args); err != nil {
			return nil, fmt.Errorf("args_invalid: %v", err)
		}
	}
	switch request.Cmd {
	case "tor":
		if !args.Enabled {
			return nil, node.tunnel.SetTorEndpoints("", "", "")
		}
		if node.socks == "" {
			return nil, errors.New("tor_unavailable: o celular não tem entrada SOCKS")
		}
		return nil, node.tunnel.SetTorEndpoints(node.socks, "", "")
	case "inspect":
		return rawJSON(node.tunnel.InspectPairPayload(args.Payload))
	case "pair":
		return rawJSON(node.tunnel.Pair(args.Payload, "Pixel do Laboratório", "Pixel 9", "android", "1.0.0"))
	case "connect":
		return rawJSON(node.tunnel.Connect(args.DesktopID))
	case "open":
		raw, err := node.tunnel.OpenDesktop(args.DesktopID, args.Token, 0)
		if err != nil {
			return nil, err
		}
		page, err := claimPage(raw)
		if err != nil {
			return nil, err
		}
		node.mu.Lock()
		node.page = page
		node.mu.Unlock()
		return json.RawMessage(raw), nil
	case "get":
		return node.get(args.Path)
	case "echo":
		socket, err := node.echo(args.Message)
		if err != nil {
			return nil, err
		}
		socket.Close(websocket.StatusNormalClosure, "")
		return nil, nil
	case "hold":
		socket, err := node.echo(args.Message)
		if err != nil {
			return nil, err
		}
		node.mu.Lock()
		node.sockets[args.Name] = socket
		node.mu.Unlock()
		go node.watch(args.Name, socket)
		return nil, nil
	case "status":
		return rawJSON(node.tunnel.StatusJSON())
	case "network":
		node.tunnel.NotifyNetworkChange(args.Reachable)
		return nil, nil
	case "stop":
		return nil, node.tunnel.Stop()
	default:
		return nil, fmt.Errorf("command_unknown: %s", request.Cmd)
	}
}

func rawJSON(raw string, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// claimPage does what the WebView does first: it loads the bootstrap URL and
// keeps the proxy cookie.
func claimPage(openJSON string) (*phonePage, error) {
	var opened proxy.OpenResult
	if err := json.Unmarshal([]byte(openJSON), &opened); err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(opened.URL)
	if err != nil {
		return nil, err
	}
	_ = response.Body.Close()
	for _, cookie := range response.Cookies() {
		if cookie.Name == proxy.CookieName {
			return &phonePage{port: opened.Port, cookie: proxy.CookieName + "=" + cookie.Value}, nil
		}
	}
	return nil, fmt.Errorf("proxy_bootstrap: HTTP %d sem cookie", response.StatusCode)
}

func (node *phoneNode) currentPage() (*phonePage, error) {
	node.mu.Lock()
	defer node.mu.Unlock()
	if node.page == nil {
		return nil, errors.New("page_closed: abra o computador antes")
	}
	return node.page, nil
}

func (node *phoneNode) get(path string) (any, error) {
	page, err := node.currentPage()
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", page.port, path), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Cookie", page.cookie)
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("page_failed: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	return map[string]any{"status": response.StatusCode, "body": string(body)}, nil
}

// echo opens /pty through the proxy, as the page does, and checks one round
// trip through the bridge.
func (node *phoneNode) echo(message string) (*websocket.Conn, error) {
	page, err := node.currentPage()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	origin := fmt.Sprintf("http://127.0.0.1:%d", page.port)
	socket, response, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/pty", page.port), &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": {page.cookie}, "Origin": {origin}},
	})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		return nil, fmt.Errorf("socket_failed: HTTP %d, %v", status, err)
	}
	if err := socket.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
		socket.CloseNow()
		return nil, fmt.Errorf("socket_failed: %v", err)
	}
	_, data, err := socket.Read(ctx)
	if err != nil || string(data) != message {
		socket.CloseNow()
		return nil, fmt.Errorf("socket_failed: eco %q, %v", data, err)
	}
	return socket, nil
}

// watch reports how a kept socket ended.
func (node *phoneNode) watch(name string, socket *websocket.Conn) {
	_, _, err := socket.Read(context.Background())
	node.mu.Lock()
	delete(node.sockets, name)
	node.mu.Unlock()
	node.out.json(map[string]any{"event": "socket", "data": map[string]any{
		"name": name, "closeStatus": int(websocket.CloseStatus(err)), "error": fmt.Sprint(err),
	}, "at": time.Now().UnixMilli()})
}

func (node *phoneNode) closeSockets() {
	node.mu.Lock()
	defer node.mu.Unlock()
	for _, socket := range node.sockets {
		socket.CloseNow()
	}
}

// startSOCKSForwarder listens on loopback, where tor.Client accepts SOCKS
// endpoints, and forwards every connection to the relay SOCKS entry.
func startSOCKSForwarder(relay string, logger *log.Logger) (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				upstream, err := net.DialTimeout("tcp", relay, 10*time.Second)
				if err != nil {
					if !strings.Contains(err.Error(), "timeout") {
						logger.Printf("SOCKS até a rede Tor simulada: %v", err)
					}
					_ = client.Close()
					return
				}
				splice(client, nil, upstream)
			}()
		}
	}()
	return listener.Addr().String(), nil
}

var _ mobile.Listener = phoneListener{}
