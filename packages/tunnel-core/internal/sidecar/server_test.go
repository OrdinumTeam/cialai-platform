// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/control"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/logx"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/statedir"
)

type fakeControlAdmin struct {
	health    func(context.Context) (control.ServerInfo, error)
	createKey func(context.Context, uint64, time.Time) (control.PreAuthKey, error)
	expireKey func(context.Context, uint64) error
}

func (admin *fakeControlAdmin) Health(ctx context.Context) (control.ServerInfo, error) {
	if admin.health != nil {
		return admin.health(ctx)
	}
	return control.ServerInfo{OK: true, Version: "0.29.3"}, nil
}
func (*fakeControlAdmin) ListUsers(context.Context) ([]control.User, error) {
	return []control.User{}, nil
}
func (*fakeControlAdmin) CreateUser(context.Context, string, string) (control.User, error) {
	return control.User{}, nil
}
func (admin *fakeControlAdmin) CreatePreAuthKey(ctx context.Context, userID uint64, expiresAt time.Time) (control.PreAuthKey, error) {
	if admin.createKey != nil {
		return admin.createKey(ctx, userID, expiresAt)
	}
	return control.PreAuthKey{}, nil
}
func (admin *fakeControlAdmin) ExpirePreAuthKey(ctx context.Context, id uint64) error {
	if admin.expireKey != nil {
		return admin.expireKey(ctx, id)
	}
	return nil
}
func (*fakeControlAdmin) ListNodes(context.Context, string) ([]control.Node, error) {
	return []control.Node{}, nil
}
func (*fakeControlAdmin) GetNode(context.Context, uint64) (control.Node, error) {
	return control.Node{}, nil
}
func (*fakeControlAdmin) ExpireNode(context.Context, uint64) error        { return nil }
func (*fakeControlAdmin) DisableNodeExpiry(context.Context, uint64) error { return nil }
func (*fakeControlAdmin) DeleteNode(context.Context, uint64) error        { return nil }
func (*fakeControlAdmin) RegisterNode(context.Context, string, string) (control.Node, error) {
	return control.Node{}, nil
}
func (*fakeControlAdmin) RotateAPIKey(context.Context, time.Time) (string, error) {
	return "hskey-api-next-secret", nil
}
func (*fakeControlAdmin) ExpireAPIKey(context.Context, string) error { return nil }

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
		`{"id":4,"cmd":"shutdown","args":{}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d; output %s", code, output.String())
	}
	frames := decodeFrames(t, output)
	if len(frames) < 5 || frames[0]["event"] != "hello" {
		t.Fatalf("unexpected frames: %#v", frames)
	}
	responses := map[uint64]map[string]any{}
	for _, frame := range frames[1:] {
		if rawID, ok := frame["id"].(float64); ok {
			responses[uint64(rawID)] = frame
		}
	}
	if responses[1]["ok"] != true || responses[2]["ok"] != true || responses[3]["ok"] != false || responses[4]["ok"] != true {
		t.Fatalf("missing responses: %#v", responses)
	}
	errorFrame := responses[3]["error"].(map[string]any)
	if errorFrame["code"] != "command_unknown" {
		t.Fatalf("unstable command error: %#v", errorFrame)
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

func TestServeControlConfigureDoesNotEchoAPIKey(t *testing.T) {
	const secret = "hskey-api-visible-secret-material"
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"control.configure","args":{"url":"https://hs.example.com","apiKey":"` + secret + `"}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	options.AdminFactory = func(rawURL, apiKey, caFile string) (control.ControlAdmin, error) {
		if rawURL != "https://hs.example.com" || apiKey != secret || caFile != "" {
			t.Fatalf("unexpected control configuration: %q %q %q", rawURL, apiKey, caFile)
		}
		return &fakeControlAdmin{}, nil
	}
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d", code)
	}
	if strings.Contains(output.String(), secret) {
		t.Fatal("control.configure echoed the full API key")
	}
	frames := decodeFrames(t, output)
	found := false
	for _, frame := range frames {
		if frame["id"] == float64(2) && frame["ok"] == true {
			found = true
		}
	}
	if !found {
		t.Fatalf("configure response missing: %#v", frames)
	}
}

type listingControlAdmin struct {
	fakeControlAdmin
	keys []control.APIKey
}

func (admin *listingControlAdmin) ListAPIKeys(context.Context) ([]control.APIKey, error) {
	return admin.keys, nil
}

func TestServeControlConfigureReportsExpiryForADashedPrefix(t *testing.T) {
	const secret = "hskey-api-FYQT-7gktHAV-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123"
	expires := time.Date(2027, 9, 12, 12, 0, 0, 0, time.UTC)
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"control.configure","args":{"url":"https://hs.example.com","apiKey":"` + secret + `"}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	options.AdminFactory = func(string, string, string) (control.ControlAdmin, error) {
		return &listingControlAdmin{keys: []control.APIKey{
			{ID: 1, Prefix: "hskey-api-FYQT-7gktHAX-***", Expiration: expires.Add(-time.Hour)},
			{ID: 2, Prefix: "hskey-api-FYQT-7gktHAV-***", Expiration: expires},
		}}, nil
	}
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d", code)
	}
	if strings.Contains(output.String(), secret) {
		t.Fatal("control.configure echoed the full API key")
	}
	for _, frame := range decodeFrames(t, output) {
		if frame["id"] != float64(2) {
			continue
		}
		result, _ := frame["result"].(map[string]any)
		apiKey, _ := result["apiKey"].(map[string]any)
		if apiKey["prefix"] != "hskey-api-FYQT-7gktHAV" || apiKey["expiresAt"] != expires.Format(time.RFC3339) {
			t.Fatalf("configure did not report the matching key: %#v", apiKey)
		}
		return
	}
	t.Fatal("configure response missing")
}

func TestShutdownCancelsCommandsInFlight(t *testing.T) {
	input := strings.Join([]string{
		`{"id":1,"cmd":"hello","args":{"protocol":1}}`,
		`{"id":2,"cmd":"control.configure","args":{"url":"https://hs.example.com","apiKey":"hskey-api-test"}}`,
		`{"id":3,"cmd":"shutdown","args":{}}`,
	}, "\n") + "\n"
	options, output := testOptions(t, input)
	options.AdminFactory = func(string, string, string) (control.ControlAdmin, error) {
		return &fakeControlAdmin{health: func(ctx context.Context) (control.ServerInfo, error) {
			select {
			case <-ctx.Done():
				return control.ServerInfo{}, ctx.Err()
			case <-time.After(2 * time.Second):
				return control.ServerInfo{}, context.DeadlineExceeded
			}
		}}, nil
	}
	started := time.Now()
	if code := Serve(context.Background(), options); code != 0 {
		t.Fatalf("serve returned %d; output %s", code, output.String())
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("shutdown waited for an uncancelled command: %s", elapsed)
	}
}
