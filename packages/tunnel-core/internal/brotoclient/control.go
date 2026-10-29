package brotoclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"
)

type controlRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type controlResponse struct {
	ID     json.RawMessage `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *controlError   `json:"error,omitempty"`
}
type controlError struct {
	Message string `json:"message"`
}

func ControlAddress(dir string) string {
	if address := os.Getenv("CIALAI_BROTO_SOCKET"); address != "" {
		return address
	}
	return platformAddress(dir)
}
func (c *Client) ServeControl(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopBase := context.AfterFunc(c.base, cancel)
	defer stopBase()
	listener, err := listenControl(ControlAddress(c.paths.Root))
	if err != nil {
		return err
	}
	defer listener.Close()
	stop := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stop()
	slots := make(chan struct{}, 16)
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case slots <- struct{}{}:
			go func() { defer func() { <-slots }(); c.controlConn(ctx, conn) }()
		default:
			_ = conn.Close()
		}
	}
}
func (c *Client) controlConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 16384)
	for scanner.Scan() {
		_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
		var request controlRequest
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			return
		}
		response := controlResponse{ID: request.ID}
		shutdown := false
		switch request.Method {
		case "broto.status":
			response.Result = c.Status()
		case "broto.shutdown":
			response.Result = map[string]bool{"ok": true}
			shutdown = true
		case "broto.pause":
			c.Pause(true)
			response.Result = c.Status()
		case "broto.resume":
			c.Pause(false)
			response.Result = c.Status()
		case "broto.disconnect":
			if err := c.Disconnect(); err != nil {
				response.Error = &controlError{"Não foi possível apagar o vínculo local."}
			} else {
				response.Result = c.Status()
			}
		case "broto.connect":
			var params struct {
				Pairing string `json:"pairing"`
			}
			if json.Unmarshal(request.Params, &params) != nil {
				response.Error = &controlError{"Código inválido."}
			} else if err := c.Connect(params.Pairing); err != nil {
				response.Error = &controlError{err.Error()}
			} else {
				response.Result = c.Status()
			}
		default:
			response.Error = &controlError{"Método desconhecido."}
		}
		raw, _ := json.Marshal(response)
		if _, err := conn.Write(append(raw, '\n')); err != nil {
			return
		}
		if shutdown {
			c.stop()
			return
		}
		_ = conn.SetDeadline(time.Time{})
	}
}
func ControlCall(ctx context.Context, dir, method string, params any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if dir == "" {
		var err error
		dir, err = DefaultDir()
		if err != nil {
			return nil, err
		}
	}
	conn, err := dialControl(ctx, ControlAddress(dir))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	p, _ := json.Marshal(params)
	raw, _ := json.Marshal(controlRequest{ID: json.RawMessage("1"), Method: method, Params: p})
	if _, err = conn.Write(append(raw, '\n')); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	if !scanner.Scan() {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err = scanner.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("control connection closed")
	}
	var response struct {
		Result json.RawMessage `json:"result"`
		Error  *controlError   `json:"error"`
	}
	if err = json.Unmarshal(scanner.Bytes(), &response); err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, errors.New(response.Error.Message)
	}
	return response.Result, nil
}
func socketDir(path string) error { return os.MkdirAll(filepath.Dir(path), 0700) }
