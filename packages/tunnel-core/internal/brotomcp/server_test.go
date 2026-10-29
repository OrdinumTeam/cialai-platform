// SPDX-License-Identifier: Apache-2.0
package brotomcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestMCPHandshakeToolsAndPermission(t *testing.T) {
	input := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rodar","arguments":{"deviceId":"remote","command":"echo","args":["ok"]}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rodar","arguments":{"deviceId":"remote","command":"echo","actor":"human"}}}
`
	var out bytes.Buffer
	calls := 0
	e := Serve(context.Background(), strings.NewReader(input), &out, func(ctx context.Context, method string, p json.RawMessage) (json.RawMessage, error) {
		calls++
		var args map[string]any
		json.Unmarshal(p, &args)
		if method != "broto.call" || args["actor"] != "ai" || args["cmd"] != "exec" {
			t.Fatalf("unexpected call %s %s", method, p)
		}
		return nil, errors.New("read-only Broto")
	})
	if e != nil {
		t.Fatal(e)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("responses: %s", out.String())
	}
	if !strings.Contains(lines[1], `"name":"esperar_texto"`) || !strings.Contains(lines[2], `"isError":true`) || !strings.Contains(lines[3], `"code":-32602`) {
		t.Fatal(out.String())
	}
	if calls != 1 {
		t.Fatal("invalid arguments reached host")
	}
}

func TestToolDescriptionsExposeExecutionLimits(t *testing.T) {
	tools := map[string]Tool{}
	for _, tool := range Tools() {
		tools[tool.Name] = tool
	}
	for name, fragments := range map[string][]string{
		"rodar":          {"5 minutos", "30 minutos", "política local", "Session 0", "janela"},
		"abrir_terminal": {"Session 0", "janela"},
		"esperar_texto":  {"30 segundos", "120 segundos", "eco", "offset", "rodar"},
	} {
		for _, fragment := range fragments {
			if !strings.Contains(tools[name].Description, fragment) {
				t.Errorf("%s does not describe %q", name, fragment)
			}
		}
	}
}

func TestWaitTextDeadlineAndEchoContract(t *testing.T) {
	for _, timeout := range []int{0, 120001} {
		raw := json.RawMessage(fmt.Sprintf(`{"deviceId":"remote","id":1,"text":"MARK","timeout_ms":%d}`, timeout))
		_, err := invoke(context.Background(), func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
			t.Fatal("invalid timeout reached host")
			return nil, nil
		}, "esperar_texto", raw)
		if !errors.Is(err, errArguments) {
			t.Fatalf("timeout %d: %v", timeout, err)
		}
	}
	for _, timeout := range []int{30000, 120000} {
		raw := json.RawMessage(`{"deviceId":"remote","id":1,"text":"MARK","offset":12}`)
		if timeout == 120000 {
			raw = json.RawMessage(`{"deviceId":"remote","id":1,"text":"MARK","offset":12,"timeout_ms":120000}`)
		}
		_, err := invoke(context.Background(), func(ctx context.Context, _ string, p json.RawMessage) (json.RawMessage, error) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > time.Duration(timeout)*time.Millisecond || time.Until(deadline) < time.Duration(timeout-1000)*time.Millisecond {
				t.Fatal("unexpected wait deadline")
			}
			var args struct {
				Args struct {
					Offset int `json:"offset"`
				} `json:"args"`
			}
			json.Unmarshal(p, &args)
			if args.Args.Offset != 12 {
				t.Fatal("offset lost")
			}
			// Raw PTY output includes the typed line. A match proves appearance,
			// and must not be presented as command completion.
			return json.RawMessage(`{"data":"cmVtIE1BUksNCg==","next_offset":22}`), nil
		}, "esperar_texto", raw)
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestWaitTextAcrossChunks(t *testing.T) {
	count := 0
	result, e := invoke(context.Background(), func(ctx context.Context, method string, args json.RawMessage) (json.RawMessage, error) {
		count++
		if count == 1 {
			return json.RawMessage(`{"data":"aGVs","next_offset":3}`), nil
		}
		return json.RawMessage(`{"data":"bG8=","next_offset":5}`), nil
	}, "esperar_texto", json.RawMessage(`{"deviceId":"remote","id":1,"text":"hello","timeout_ms":1000}`))
	if e != nil || string(result) != `{"matched":true}` {
		t.Fatalf("%s %v", result, e)
	}
}
func TestRejectBeforeInitialization(t *testing.T) {
	var out bytes.Buffer
	e := Serve(context.Background(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`), &out, nil)
	if e != nil || !strings.Contains(out.String(), `-32002`) {
		t.Fatalf("%s %v", out.String(), e)
	}
}
func TestWaitTextDrainsExitedSession(t *testing.T) {
	count := 0
	result, e := invoke(context.Background(), func(ctx context.Context, method string, args json.RawMessage) (json.RawMessage, error) {
		count++
		outputs := []string{`{"data":"Zmlyc3Q=","next_offset":5,"total_offset":16,"exited":true}`, `{"data":"c2Vjb25k","next_offset":11,"total_offset":16,"exited":true}`, `{"data":"aGVsbG8=","next_offset":16,"total_offset":16,"exited":true}`}
		if count > len(outputs) {
			t.Fatal("read beyond session")
		}
		return json.RawMessage(outputs[count-1]), nil
	}, "esperar_texto", json.RawMessage(`{"deviceId":"remote","id":1,"text":"hello","timeout_ms":1000}`))
	if e != nil || string(result) != `{"matched":true}` || count != 3 {
		t.Fatalf("result %s count %d err %v", result, count, e)
	}
}

func TestFileToolsAndStreamingExec(t *testing.T) {
	names := map[string]bool{}
	for _, tool := range Tools() {
		names[tool.Name] = true
	}
	for _, name := range []string{"enviar_arquivo", "baixar_arquivo", "listar_arquivos"} {
		if !names[name] {
			t.Fatal("missing", name)
		}
	}
	call := func(ctx context.Context, method string, raw json.RawMessage) (json.RawMessage, error) {
		var p struct {
			Cmd   string         `json:"cmd"`
			Actor string         `json:"actor"`
			Args  map[string]any `json:"args"`
		}
		if e := json.Unmarshal(raw, &p); e != nil {
			t.Fatal(e)
		}
		if p.Actor != "ai" {
			t.Fatal("actor not AI")
		}
		switch p.Cmd {
		case "exec":
			if p.Args["stream"] != true {
				t.Fatal("exec not streamed")
			}
		case "files.list":
			if p.Args["path"] != "." {
				t.Fatal("path lost")
			}
		default:
			t.Fatal(p.Cmd)
		}
		return json.RawMessage(`{}`), nil
	}
	if _, e := invoke(context.Background(), call, "rodar", json.RawMessage(`{"deviceId":"d","command":"echo"}`)); e != nil {
		t.Fatal(e)
	}
	if _, e := invoke(context.Background(), call, "listar_arquivos", json.RawMessage(`{"deviceId":"d","path":"."}`)); e != nil {
		t.Fatal(e)
	}
	if _, e := invoke(context.Background(), call, "enviar_arquivo", json.RawMessage(`{"deviceId":"d","source":"x","destination":"y","overwrite":"yes"}`)); !errors.Is(e, errArguments) {
		t.Fatal("invalid overwrite accepted", e)
	}
}
