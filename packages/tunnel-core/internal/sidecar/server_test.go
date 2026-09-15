// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

func testOptions(t *testing.T, input string) (Options, *bytes.Buffer) {
	t.Helper()
	paths, err := statedir.Prepare(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	return Options{
		Paths: paths, Input: strings.NewReader(input), Output: &output,
		Logger: logx.New(&bytes.Buffer{}, 20), HandshakeTimeout: 50 * time.Millisecond,
	}, &output
}

func decodeFrames(t *testing.T, output *bytes.Buffer) []map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	frames := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		var frame map[string]any
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatalf("invalid frame %q: %v", line, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func TestServeRequiresHelloAsFirstRequest(t *testing.T) {
	options, output := testOptions(t, "")
	if code := Serve(context.Background(), options); code != 2 {
		t.Fatalf("missing handshake returned %d", code)
	}
	frames := decodeFrames(t, output)
	if len(frames) != 1 || frames[0]["event"] != "hello" {
		t.Fatalf("hello event missing: %#v", frames)
	}

	options, output = testOptions(t, `{"id":1,"cmd":"logs.tail","args":{}}`+"\n")
	if code := Serve(context.Background(), options); code != 2 {
		t.Fatalf("wrong first command returned %d", code)
	}
	frames = decodeFrames(t, output)
	if len(frames) != 2 || frames[1]["ok"] != false {
		t.Fatalf("handshake rejection missing: %#v", frames)
	}
}

func TestServeNegotiatesProtocolDispatchesAndShutsDown(t *testing.T) {
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"logs.tail","args":{"lines":10}}`,
		`{"id":3,"cmd":"unknown.command","args":{}}`,
		`{"id":4,"cmd":"net.status","args":{}}`,
		`{"id":5,"cmd":"shutdown","args":{}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d; output %s", code, output.String())
	}
	frames := decodeFrames(t, output)
	if len(frames) < 6 || frames[0]["event"] != "hello" {
		t.Fatalf("unexpected frames: %#v", frames)
	}
	responses := map[uint64]map[string]any{}
	for _, frame := range frames[1:] {
		if rawID, ok := frame["id"].(float64); ok {
			responses[uint64(rawID)] = frame
		}
	}
	for id, ok := range map[uint64]bool{1: true, 2: true, 3: false, 4: true, 5: true} {
		if responses[id]["ok"] != ok {
			t.Fatalf("response %d: %#v", id, responses[id])
		}
	}
	result := responses[1]["result"].(map[string]any)
	capabilities := []string{}
	for _, value := range result["capabilities"].([]any) {
		capabilities = append(capabilities, value.(string))
	}
	if !slices.Equal(capabilities, []string{"direct", "tor", "pairing", "devices"}) {
		t.Fatalf("hello announced %v", capabilities)
	}
	errorFrame := responses[3]["error"].(map[string]any)
	if errorFrame["code"] != "command_unknown" {
		t.Fatalf("unstable command error: %#v", errorFrame)
	}
	status := responses[4]["result"].(map[string]any)
	if status["state"] != "stopped" || status["tor"].(map[string]any)["state"] != "disabled" {
		t.Fatalf("stopped status: %#v", status)
	}
}

func TestServeRejectsDuplicateRequestIDs(t *testing.T) {
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"logs.tail","args":{}}`,
		`{"id":2,"cmd":"logs.tail","args":{}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d", code)
	}
	frames := decodeFrames(t, output)
	foundDuplicate := false
	for _, frame := range frames {
		problem, ok := frame["error"].(map[string]any)
		if ok && problem["code"] == "request_duplicate" {
			foundDuplicate = true
		}
	}
	if !foundDuplicate {
		t.Fatalf("duplicate id was not rejected: %#v", frames)
	}
}

// The Headscale commands left the RPC; their packages stay inert until
// CON-070.
func TestServeNoLongerKnowsControlAndNodeCommands(t *testing.T) {
	commands := []string{"control.configure", "control.users.list", "control.apikey.rotate", "node.up", "node.status", "node.logout", "edge.serve", "edge.stop"}
	lines := []string{`{"id":1,"cmd":"hello","args":{"protocol":1}}`}
	for index, command := range commands {
		raw, _ := json.Marshal(map[string]any{"id": index + 2, "cmd": command, "args": map[string]any{}})
		lines = append(lines, string(raw))
	}
	options, output := testOptions(t, strings.Join(lines, "\n")+"\n")
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d", code)
	}
	unknown := 0
	for _, frame := range decodeFrames(t, output) {
		if problem, ok := frame["error"].(map[string]any); ok && problem["code"] == "command_unknown" {
			unknown++
		}
	}
	if unknown != len(commands) {
		t.Fatalf("%d of %d removed commands answered command_unknown: %s", unknown, len(commands), output.String())
	}
}

func TestShutdownCancelsCommandsInFlight(t *testing.T) {
	h := startHarness(t, harnessOptions{mapper: func() *fakeMapper { return &fakeMapper{blockProbe: true} }})
	h.start(t, map[string]any{})
	diagnostics := make(chan frame, 1)
	go func() { diagnostics <- h.request("diagnostics.run", map[string]any{}, 10*time.Second) }()
	time.Sleep(100 * time.Millisecond)
	started := time.Now()
	h.shutdown(t)
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("shutdown waited for an uncancelled command: %s", elapsed)
	}
	select {
	case <-diagnostics:
	case <-time.After(5 * time.Second):
		t.Fatal("diagnostics.run never answered")
	}
}
