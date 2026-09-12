// SPDX-License-Identifier: Apache-2.0
package rpc

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestReaderAcceptsOneStrictRequestPerLine(t *testing.T) {
	reader := NewReader(strings.NewReader("{\"id\":7,\"cmd\":\"node.status\",\"args\":{}}\n"))
	request, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if request.ID != 7 || request.Command != "node.status" || string(request.Args) != "{}" {
		t.Fatalf("unexpected request: %#v", request)
	}
	for _, line := range []string{
		"{}\n",
		"{\"id\":1,\"cmd\":\"x\",\"args\":{},\"extra\":true}\n",
		"{\"id\":1,\"cmd\":\"x\",\"args\":{}} trailing\n",
	} {
		if _, err := NewReader(strings.NewReader(line)).Next(); err == nil {
			t.Fatalf("accepted invalid frame %q", line)
		}
	}
}

func TestReaderRejectsFramesAboveTheWireLimit(t *testing.T) {
	line := "{\"id\":1,\"cmd\":\"x\",\"args\":{\"value\":\"" + strings.Repeat("a", MaxLineBytes) + "\"}}\n"
	if _, err := NewReader(strings.NewReader(line)).Next(); err == nil || !strings.Contains(err.Error(), "256 KiB") {
		t.Fatalf("expected bounded frame error, got %v", err)
	}
}

func TestWriterEmitsResponsesAndEventsAsSingleJSONLines(t *testing.T) {
	var output bytes.Buffer
	writer := NewWriter(&output)
	if err := writer.Write(Success(9, map[string]any{"state": "running"})); err != nil {
		t.Fatal(err)
	}
	event, err := NewEvent("node.state", map[string]any{"state": "running"}, time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Write(event); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected two frames, got %q", output.String())
	}
	var response Response
	if err := json.Unmarshal([]byte(lines[0]), &response); err != nil || !response.OK || response.ID != 9 {
		t.Fatalf("bad response: %#v, %v", response, err)
	}
	if !strings.Contains(lines[1], `"event":"node.state"`) || !strings.Contains(lines[1], `"ts":"2026-09-12T20:00:00Z"`) {
		t.Fatalf("bad event: %s", lines[1])
	}
}

func TestFailureCarriesStableMachineReadableError(t *testing.T) {
	response := Failure(4, "control_unreachable", "Servidor indisponível", true)
	if response.OK || response.Error == nil || response.Error.Code != "control_unreachable" || !response.Error.Retryable {
		t.Fatalf("unexpected failure: %#v", response)
	}
}
