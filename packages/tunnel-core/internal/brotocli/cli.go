// SPDX-License-Identifier: Apache-2.0
// Package brotocli exposes the AI-only host IPC to terminal agents.
package brotocli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotohostipc"
)

type Caller func(context.Context, string, json.RawMessage) (json.RawMessage, error)
type StreamCaller func(context.Context, string, json.RawMessage, func(string, json.RawMessage)) (json.RawMessage, error)
type CLI struct {
	Call     Caller
	Stream   StreamCaller
	Out, Err io.Writer
}
type Device struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	State     string `json:"state"`
	Transport string `json:"transport"`
	Level     string `json:"level"`
	Shell     string `json:"shell"`
	Number    int    `json:"number"`
}

func encode(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func Run(ctx context.Context, args []string, out, errout io.Writer) int {
	path, e := brotohostipc.DefaultPath()
	if e != nil {
		fmt.Fprintln(errout, e)
		return 120
	}
	c := CLI{Out: out, Err: errout}
	c.Call = func(ctx context.Context, m string, p json.RawMessage) (json.RawMessage, error) {
		return brotohostipc.Call(ctx, path, m, p)
	}
	c.Stream = func(ctx context.Context, m string, p json.RawMessage, f func(string, json.RawMessage)) (json.RawMessage, error) {
		return brotohostipc.CallStream(ctx, path, m, p, f)
	}
	return c.Run(ctx, args)
}
func failureCode(e error) int {
	s := strings.ToLower(e.Error())
	switch {
	case strings.Contains(s, "approval expired"):
		return 123
	case strings.Contains(s, "declined"), strings.Contains(s, "read only"), strings.Contains(s, "read-only"):
		return 122
	case strings.Contains(s, "offline"), strings.Contains(s, "disconnected"), strings.Contains(s, "paused"), strings.Contains(s, "pausado"):
		return 121
	case errors.Is(e, context.DeadlineExceeded), strings.Contains(s, "timed out"):
		return 124
	}
	return 125
}
func (c CLI) Run(ctx context.Context, args []string) int {
	jsonMode := false
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "--json" {
			jsonMode = true
		}
	}
	code, e := c.execute(ctx, args, jsonMode)
	if e != nil {
		if code == 0 {
			code = failureCode(e)
		}
		if jsonMode {
			fmt.Fprintln(c.Out, string(encode(map[string]any{"failure": e.Error(), "code": code})))
		} else {
			fmt.Fprintln(c.Err, localize(e.Error()))
		}
	}
	return code
}
func selectDevice(ds []Device, key string) (Device, error) {
	if n, e := strconv.Atoi(key); e == nil && n > 0 && n <= len(ds) {
		return ds[n-1], nil
	}
	exact := []Device{}
	for _, d := range ds {
		if strings.EqualFold(d.Name, key) {
			exact = append(exact, d)
		}
	}
	if len(exact) == 1 {
		return exact[0], nil
	}
	matches := []Device{}
	for _, d := range ds {
		if strings.HasPrefix(strings.ToLower(d.Name), strings.ToLower(key)) {
			matches = append(matches, d)
		}
	}
	if len(matches) == 1 && len(exact) == 0 {
		return matches[0], nil
	}
	for _, d := range ds {
		if d.ID == key {
			return d, nil
		}
	}
	candidates := []string{}
	for _, d := range ds {
		candidates = append(candidates, d.Name)
	}
	return Device{}, fmt.Errorf("Broto ambíguo ou inexistente: %s", strings.Join(candidates, ", "))
}
func parse(args []string) ([]string, map[string]string, error) {
	pos := []string{}
	opts := map[string]string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") {
			pos = append(pos, a)
			continue
		}
		switch a {
		case "--json", "--enter", "--substituir":
			opts[a] = "true"
		case "--pasta", "--prazo", "--programa", "--desde":
			i++
			if i >= len(args) {
				return nil, nil, errors.New("opção exige valor")
			}
			opts[a] = args[i]
		default:
			return nil, nil, fmt.Errorf("opção desconhecida: %s", a)
		}
	}
	return pos, opts, nil
}
func (c CLI) remote(ctx context.Context, d Device, verb string, args any) (json.RawMessage, error) {
	return c.Call(ctx, "broto.call", encode(map[string]any{"deviceId": d.ID, "cmd": verb, "args": args, "actor": "ai"}))
}
func (c CLI) execute(ctx context.Context, args []string, j bool) (int, error) {
	p, o, e := parse(args)
	if e != nil {
		return 125, e
	}
	if len(p) == 0 {
		return 125, errors.New("uso: cialai broto listar|rodar|terminal|arquivos|enviar|baixar")
	}
	allowed := map[string]bool{"--json": true}
	allow := func(keys ...string) {
		for _, k := range keys {
			allowed[k] = true
		}
	}
	switch p[0] {
	case "listar", "arquivos", "baixar":
	case "enviar":
		allow("--substituir")
	case "rodar":
		allow("--pasta", "--prazo", "--programa")
	case "terminal":
		if len(p) < 2 {
			return 125, errors.New("ação de terminal desconhecida")
		}
		switch p[1] {
		case "abrir":
			allow("--pasta")
		case "ler":
			allow("--desde")
		case "escrever":
			allow("--enter")
		case "esperar":
			allow("--desde", "--prazo")
		case "fechar":
		default:
			return 125, errors.New("ação de terminal desconhecida")
		}
	default:
		return 125, errors.New("ação desconhecida")
	}
	for k := range o {
		if !allowed[k] {
			return 125, fmt.Errorf("opção desconhecida: %s", k)
		}
	}
	raw, e := c.Call(ctx, "broto.list", encode(map[string]any{}))
	if e != nil {
		return 120, errors.New("O Cialai não está aberto neste computador.")
	}
	var ds []Device
	if e = json.Unmarshal(raw, &ds); e != nil {
		return 125, e
	}
	if p[0] == "listar" {
		if len(p) != 1 {
			return 125, errors.New("uso: listar [--json]")
		}
		sessions, e := c.Call(ctx, "broto.sessions", encode(map[string]any{}))
		counts := map[string]int{}
		if e == nil {
			var list []struct {
				Device string `json:"deviceId"`
				Exited bool   `json:"exited"`
			}
			if json.Unmarshal(sessions, &list) == nil {
				for _, v := range list {
					if !v.Exited {
						counts[v.Device]++
					}
				}
			}
		}
		var enriched []map[string]any
		if json.Unmarshal(raw, &enriched) == nil {
			for _, v := range enriched {
				v["sessions"] = counts[fmt.Sprint(v["id"])]
			}
			raw = encode(enriched)
		}
		if j {
			fmt.Fprintln(c.Out, string(raw))
		} else {
			for i, d := range ds {
				fmt.Fprintf(c.Out, "%d\t%s\t%s\t%s\t%s\t%s\t%s\t%d\n", i+1, d.Name, d.Platform, localize(d.State), d.Transport, localize(d.Level), d.Shell, counts[d.ID])
			}
		}
		return 0, nil
	}
	idx := 1
	if p[0] == "terminal" {
		idx = 2
	}
	if len(p) <= idx {
		return 125, errors.New("informe o Broto")
	}
	d, e := selectDevice(ds, p[idx])
	if e != nil {
		return 125, e
	}
	if d.State == "disconnected" || d.State == "paused" {
		return 121, errors.New("Broto desconectado ou pausado")
	}
	if d.Level == "confirm" && p[0] != "arquivos" && !(p[0] == "terminal" && (p[1] == "ler" || p[1] == "esperar")) {
		fmt.Fprintln(c.Err, localize("Pedidos da IA aguardam aprovação no Cialai."))
	}
	a := map[string]any{}
	if o["--pasta"] != "" {
		a["dir"] = o["--pasta"]
	}
	switch p[0] {
	case "rodar":
		duration := 5 * time.Minute
		if o["--prazo"] != "" {
			duration, e = time.ParseDuration(o["--prazo"])
			if e != nil || duration <= 0 {
				return 125, errors.New("prazo inválido")
			}
		}
		a["timeout_ms"] = duration.Milliseconds()
		a["stream"] = true
		if exe := o["--programa"]; exe != "" {
			a["command"] = exe
			a["args"] = p[2:]
		} else {
			if len(p) != 3 {
				return 125, errors.New("informe uma linha de comando")
			}
			shell := d.Shell
			if shell == "" {
				shell = "/bin/sh"
			}
			a["command"] = shell
			a["args"] = []string{"-lc", p[2]}
			if strings.EqualFold(d.Platform, "windows") {
				a["command"] = "powershell.exe"
				a["args"] = []string{"-NoProfile", "-NonInteractive", "-Command", p[2]}
			}
		}
		streamed := false
		params := encode(map[string]any{"deviceId": d.ID, "cmd": "exec", "args": a, "actor": "ai"})
		if c.Stream != nil {
			raw, e = c.Stream(ctx, "broto.call", params, func(event string, data json.RawMessage) {
				if event != "broto.exec.output" {
					return
				}
				var v struct {
					Data    []byte `json:"data"`
					Channel string `json:"channel"`
				}
				if json.Unmarshal(data, &v) != nil {
					return
				}
				streamed = true
				if j {
					fmt.Fprintln(c.Out, string(encode(map[string]any{"event": event, "data": json.RawMessage(data)})))
				} else {
					w := c.Out
					if v.Channel == "stderr" {
						w = c.Err
					}
					w.Write(v.Data)
				}
			})
		} else {
			raw, e = c.Call(ctx, "broto.call", params)
		}
		if e != nil {
			return 0, e
		}
		var v struct {
			Exit    int    `json:"exit_code"`
			Timeout bool   `json:"timed_out"`
			Stdout  string `json:"stdout"`
			Stderr  string `json:"stderr"`
		}
		if e = json.Unmarshal(raw, &v); e != nil {
			return 125, e
		}
		if v.Timeout {
			var result map[string]any
			if json.Unmarshal(raw, &result) == nil {
				result["failure"] = "timeout"
				raw = encode(result)
			}
		}
		if j {
			fmt.Fprintln(c.Out, string(raw))
		} else if !streamed {
			fmt.Fprint(c.Out, v.Stdout)
			fmt.Fprint(c.Err, v.Stderr)
		}
		if v.Timeout {
			return 124, nil
		}
		return v.Exit, nil
	case "terminal":
		verb := map[string]string{"abrir": "pty.open", "ler": "pty.read", "escrever": "pty.write", "esperar": "pty.read", "fechar": "pty.kill"}[p[1]]
		if verb == "" {
			return 125, errors.New("ação de terminal desconhecida")
		}
		expected := 4
		if p[1] == "abrir" {
			expected = 3
		} else if p[1] == "escrever" || p[1] == "esperar" {
			expected = 5
		}
		if len(p) != expected {
			return 125, errors.New("informe a sessão")
		}
		if p[1] != "abrir" {
			if len(p) < 4 {
				return 125, errors.New("informe a sessão")
			}
			id, err := strconv.ParseUint(p[3], 10, 32)
			if err != nil || id == 0 {
				return 125, errors.New("sessão inválida")
			}
			a["id"] = id
		}
		if o["--desde"] != "" {
			n, err := strconv.ParseUint(o["--desde"], 10, 64)
			if err != nil {
				return 125, err
			}
			a["offset"] = n
		}
		if p[1] == "escrever" {
			if len(p) != 5 {
				return 125, errors.New("informe o texto")
			}
			text := p[4]
			if o["--enter"] != "" {
				text += "\r"
			}
			a["data"] = []byte(text)
		}
		if p[1] == "esperar" {
			if len(p) != 5 || p[4] == "" {
				return 125, errors.New("informe o texto esperado")
			}
			return c.wait(ctx, d, a, p[4], o["--prazo"], j)
		}
		raw, e = c.remote(ctx, d, verb, a)
		if e != nil {
			return 0, e
		}
		if p[1] == "ler" {
			return c.printRead(raw, j)
		}
	case "arquivos":
		if len(p) != 3 {
			return 125, errors.New("informe a pasta")
		}
		raw, e = c.remote(ctx, d, "files.list", map[string]any{"path": p[2]})
	case "enviar":
		if len(p) != 4 {
			return 125, errors.New("informe origem e destino")
		}
		raw, e = Upload(ctx, c.Call, d.ID, p[2], p[3], o["--substituir"] != "", c.Err)
	case "baixar":
		if len(p) < 3 || len(p) > 4 {
			return 125, errors.New("informe origem e destino opcional")
		}
		dest := ""
		if len(p) == 4 {
			dest = p[3]
		}
		raw, e = Download(ctx, c.Call, d.ID, p[2], dest, c.Err)
	default:
		return 125, errors.New("ação desconhecida")
	}
	if e != nil {
		return 0, e
	}
	if j {
		fmt.Fprintln(c.Out, string(raw))
	} else if p[0] == "terminal" {
		if p[1] == "abrir" {
			var opened struct {
				ID uint64 `json:"id"`
			}
			if e = json.Unmarshal(raw, &opened); e != nil {
				return 125, e
			}
			fmt.Fprintln(c.Out, opened.ID)
		}
	} else if p[0] == "arquivos" {
		var entries []struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Size int64  `json:"size"`
		}
		if e = json.Unmarshal(raw, &entries); e != nil {
			return 125, e
		}
		for _, v := range entries {
			fmt.Fprintf(c.Out, "%s\t%s\t%d\n", v.Name, v.Type, v.Size)
		}
	} else {
		var v struct {
			Size int64  `json:"size"`
			SHA  string `json:"sha256"`
		}
		if e = json.Unmarshal(raw, &v); e != nil {
			return 125, e
		}
		fmt.Fprintf(c.Out, "%d bytes\nSHA256 %s\n", v.Size, v.SHA)
	}
	return 0, nil
}

// ansiCleaner retains incomplete escape sequences between terminal reads.
type ansiCleaner struct{ state byte }

func (c *ansiCleaner) Write(b []byte) string {
	var out strings.Builder
	for _, v := range b {
		switch c.state {
		case 0:
			if v == 27 {
				c.state = 1
			} else if v >= 32 || v == '\n' || v == '\r' || v == '\t' {
				out.WriteByte(v)
			}
		case 1:
			switch v {
			case '[':
				c.state = 2
			case ']':
				c.state = 3
			case 'P', 'X', '^', '_':
				c.state = 3
			default:
				if v >= 0x30 {
					c.state = 0
				}
			}
		case 2:
			if v >= 0x40 && v <= 0x7e {
				c.state = 0
			}
		case 3:
			if v == 7 {
				c.state = 0
			} else if v == 27 {
				c.state = 4
			}
		case 4:
			if v == '\\' {
				c.state = 0
			} else {
				c.state = 3
			}
		}
	}
	return out.String()
}
func clean(b []byte) string { var c ansiCleaner; return c.Write(b) }

type output struct {
	Data   []byte `json:"data"`
	Next   uint64 `json:"next_offset"`
	Total  uint64 `json:"total_offset"`
	Exited bool   `json:"exited"`
}

func (c CLI) printRead(raw json.RawMessage, j bool) (int, error) {
	var v output
	if e := json.Unmarshal(raw, &v); e != nil {
		return 125, e
	}
	text := clean(v.Data)
	if j {
		fmt.Fprintln(c.Out, string(encode(map[string]any{"text": text, "next_offset": v.Next, "exited": v.Exited})))
	} else {
		fmt.Fprint(c.Out, text)
		fmt.Fprintf(c.Err, "\nnext_offset: %d\n", v.Next)
	}
	return 0, nil
}
func (c CLI) wait(ctx context.Context, d Device, a map[string]any, text, deadline string, j bool) (int, error) {
	duration := 2 * time.Minute
	var e error
	if deadline != "" {
		duration, e = time.ParseDuration(deadline)
		if e != nil || duration <= 0 {
			return 125, errors.New("prazo inválido")
		}
	}
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	tail := ""
	var cleaner ansiCleaner
	for {
		raw, e := c.remote(ctx, d, "pty.read", a)
		if e != nil {
			return 0, e
		}
		var v output
		if e = json.Unmarshal(raw, &v); e != nil {
			return 125, e
		}
		tail += cleaner.Write(v.Data)
		if strings.Contains(tail, text) {
			if j {
				fmt.Fprintln(c.Out, string(encode(map[string]any{"matched": true, "text": tail, "next_offset": v.Next})))
			} else {
				fmt.Fprint(c.Out, tail)
			}
			return 0, nil
		}
		if v.Exited && v.Next >= v.Total {
			return 125, errors.New("sessão encerrou antes do texto")
		}
		if len(tail) > len(text)+65536 {
			tail = tail[len(tail)-len(text)-65536:]
		}
		a["offset"] = v.Next
		select {
		case <-ctx.Done():
			return 124, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
