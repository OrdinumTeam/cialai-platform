package brotocli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestSelection(t *testing.T) {
	ds := []Device{{ID: "a", Name: "Windows"}, {ID: "b", Name: "Linux"}, {ID: "c", Name: "Linus"}}
	for key, want := range map[string]string{"1": "a", "WINDOWS": "a", "Win": "a", "b": "b"} {
		d, e := selectDevice(ds, key)
		if e != nil || d.ID != want {
			t.Fatalf("%s: %+v %v", key, d, e)
		}
	}
	if _, e := selectDevice(ds, "Lin"); e == nil {
		t.Fatal("ambiguous prefix accepted")
	}
}
func TestRunPreservesProgramArgsAndExit(t *testing.T) {
	var out, stderr bytes.Buffer
	var got map[string]json.RawMessage
	c := CLI{Out: &out, Err: &stderr, Call: func(ctx context.Context, m string, p json.RawMessage) (json.RawMessage, error) {
		if m == "broto.list" {
			return json.RawMessage(`[{"id":"a","name":"Win","platform":"windows","state":"connected"}]`), nil
		}
		var call struct {
			Args map[string]json.RawMessage `json:"args"`
		}
		json.Unmarshal(p, &call)
		got = call.Args
		return json.RawMessage(`{"exit_code":7,"stdout":"ok"}`), nil
	}}
	if code := c.Run(context.Background(), []string{"rodar", "1", "--programa", "node", "--", "-e", "a b"}); code != 7 {
		t.Fatal(code)
	}
	if string(got["args"]) != `["-e","a b"]` || out.String() != "ok" {
		t.Fatalf("%s %s", got["args"], out.String())
	}
}
func TestShellAndStream(t *testing.T) {
	var out, stderr bytes.Buffer
	c := CLI{Out: &out, Err: &stderr, Call: func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`[{"id":"a","name":"Win","platform":"windows","state":"connected"}]`), nil
	}, Stream: func(ctx context.Context, m string, p json.RawMessage, event func(string, json.RawMessage)) (json.RawMessage, error) {
		var v struct {
			Args struct {
				Command string   `json:"command"`
				Args    []string `json:"args"`
				Stream  bool     `json:"stream"`
			} `json:"args"`
		}
		json.Unmarshal(p, &v)
		if v.Args.Command != "powershell.exe" || !v.Args.Stream || v.Args.Args[3] != "echo hi" {
			t.Fatalf("%s", p)
		}
		event("broto.exec.output", json.RawMessage(`{"data":"aGk=","channel":"stdout"}`))
		return json.RawMessage(`{"exit_code":0,"stdout":"hi"}`), nil
	}}
	if code := c.Run(context.Background(), []string{"rodar", "1", "echo hi"}); code != 0 || out.String() != "hi" {
		t.Fatalf("%d %s", code, out.String())
	}
}
func TestFailureCodes(t *testing.T) {
	for message, want := range map[string]int{"approval expired": 123, "command declined": 122, "Broto offline": 121, "read only": 122, "text wait timed out": 124, "other": 125} {
		if got := failureCode(errors.New(message)); got != want {
			t.Fatalf("%s %d", message, got)
		}
	}
}
func TestReadStripsANSI(t *testing.T) {
	if got := clean([]byte("\x1b[31mhello\x1b[0m\x07")); got != "hello" {
		t.Fatal(got)
	}
}

func TestListIncludesSessionsAndStableNumbers(t *testing.T) {
	var out, stderr bytes.Buffer
	c := CLI{Out: &out, Err: &stderr, Call: func(ctx context.Context, m string, p json.RawMessage) (json.RawMessage, error) {
		if m == "broto.list" {
			return json.RawMessage(`[{"id":"a","name":"Win","number":1,"shell":"powershell.exe"}]`), nil
		}
		return json.RawMessage(`[{"deviceId":"a","exited":false},{"deviceId":"a","exited":true}]`), nil
	}}
	if code := c.Run(context.Background(), []string{"listar", "--json"}); code != 0 {
		t.Fatal(code)
	}
	var ds []map[string]any
	if e := json.Unmarshal(out.Bytes(), &ds); e != nil || ds[0]["sessions"] != float64(1) || ds[0]["number"] != float64(1) {
		t.Fatal(out.String(), e)
	}
}
func TestRejectOptionsBeforeContactingHost(t *testing.T) {
	var out bytes.Buffer
	c := CLI{Out: &out, Err: &out, Call: func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		t.Fatal("contacted host for invalid use")
		return nil, nil
	}}
	if code := c.Run(context.Background(), []string{"listar", "--programa", "x"}); code != 125 {
		t.Fatal(code)
	}
}
func TestLocale(t *testing.T) {
	t.Setenv("LC_ALL", "en_US.UTF-8")
	if got := localize("prazo inválido"); got != "invalid timeout" {
		t.Fatal(got)
	}
	t.Setenv("LC_ALL", "es_ES.UTF-8")
	if got := localize("prazo inválido"); got != "plazo inválido" {
		t.Fatal(got)
	}
}

func TestWaitHandlesANSISequenceSplitAcrossReads(t *testing.T) {
	var out, errout bytes.Buffer
	calls := 0
	c := CLI{Out: &out, Err: &errout, Call: func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		calls++
		if calls == 1 {
			return encode(map[string]any{"data": []byte("he\x1b[31"), "next_offset": 7}), nil
		}
		return encode(map[string]any{"data": []byte("mllo\x1b[0m"), "next_offset": 15}), nil
	}}
	code, e := c.wait(context.Background(), Device{ID: "a"}, map[string]any{"id": 1}, "hello", "1s", false)
	if e != nil || code != 0 || out.String() != "hello" {
		t.Fatalf("%d %v %q", code, e, out.String())
	}
}

func TestJSONDistinguishesRemote124FromTimeout(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		var out bytes.Buffer
		c := CLI{Out: &out, Err: &out, Call: func(ctx context.Context, m string, p json.RawMessage) (json.RawMessage, error) {
			if m == "broto.list" {
				return json.RawMessage(`[{"id":"a","name":"test","state":"connected"}]`), nil
			}
			return encode(map[string]any{"exit_code": 124, "timed_out": timeout}), nil
		}}
		if code := c.Run(context.Background(), []string{"rodar", "1", "echo hi", "--json"}); code != 124 {
			t.Fatal(code)
		}
		var v map[string]any
		if e := json.Unmarshal(out.Bytes(), &v); e != nil {
			t.Fatal(e)
		}
		_, failed := v["failure"]
		if failed != timeout {
			t.Fatal("remote exit confused with timeout", out.String())
		}
	}
}
