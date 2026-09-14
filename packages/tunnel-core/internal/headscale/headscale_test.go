// SPDX-License-Identifier: Apache-2.0
package headscale

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/control"
)

const testAPIKey = "hskey-api-test-secret"

type observedRequest struct {
	method string
	path   string
	query  url.Values
	body   map[string]any
}

func TestHeadscaleDirectImplementsEveryAdministrativeEndpoint(t *testing.T) {
	now := time.Date(2026, 9, 12, 20, 0, 0, 0, time.UTC)
	requests := make([]observedRequest, 0, 12)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+testAPIKey {
			t.Error("missing bearer authentication")
		}
		var body map[string]any
		if request.Body != nil {
			_ = json.NewDecoder(request.Body).Decode(&body)
		}
		requests = append(requests, observedRequest{request.Method, request.URL.Path, request.URL.Query(), body})
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Date", now.Format(http.TimeFormat))
		switch request.Method + " " + request.URL.Path {
		case "GET /api/v1/health":
			_, _ = response.Write([]byte(`{"status":"online","version":"0.29.3"}`))
		case "GET /api/v1/user":
			_, _ = response.Write([]byte(`{"users":[{"id":"42","name":"alice","displayName":"Alice","createdAt":"2026-09-01T10:00:00Z"}]}`))
		case "POST /api/v1/user":
			_, _ = response.Write([]byte(`{"user":{"id":"43","name":"bob","displayName":"Bob"}}`))
		case "POST /api/v1/preauthkey":
			_, _ = response.Write([]byte(`{"preAuthKey":{"id":"17","key":"tskey-auth-test-secret","expiration":"2026-09-13T20:00:00Z","used":false}}`))
		case "POST /api/v1/preauthkey/expire":
			_, _ = response.Write([]byte(`{}`))
		case "GET /api/v1/node":
			_, _ = response.Write([]byte(`{"nodes":[{"id":"5","nodeKey":"nodekey:desktop","machineKey":"mkey:desktop","ipAddresses":["100.64.0.2"],"name":"desktop","givenName":"Desktop","online":true,"lastSeen":"2026-09-12T19:00:00Z","expiry":"2027-09-12T19:00:00Z","user":{"id":"42"},"registerMethod":"authKey"}]}`))
		case "GET /api/v1/node/5":
			_, _ = response.Write([]byte(`{"node":{"id":"5","nodeKey":"nodekey:desktop","name":"desktop","user":{"id":"42"}}}`))
		case "POST /api/v1/node/5/expire":
			_, _ = response.Write([]byte(`{"node":{"id":"5","nodeKey":"nodekey:desktop","name":"desktop","user":{"id":"42"}}}`))
		case "DELETE /api/v1/node/5":
			_, _ = response.Write([]byte(`{}`))
		case "POST /api/v1/node/register":
			_, _ = response.Write([]byte(`{"node":{"id":"6","nodeKey":"nodekey:phone","name":"phone","user":{"id":"42"}}}`))
		case "POST /api/v1/apikey":
			_, _ = response.Write([]byte(`{"apiKey":"hskey-api-new-secret"}`))
		case "POST /api/v1/apikey/expire":
			_, _ = response.Write([]byte(`{}`))
		case "GET /api/v1/apikey":
			_, _ = response.Write([]byte(`{"apiKeys":[{"id":"3","prefix":"hskey-api-FYQT-7gktHAV-***","expiration":"2026-09-13T20:00:00Z","createdAt":"2026-09-12T20:00:00Z","lastSeen":null}]}`))
		default:
			http.Error(response, "unexpected endpoint", http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, err := NewWithOptions(server.URL, testAPIKey, "", Options{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	health, err := client.Health(ctx)
	if err != nil || !health.OK || health.Version != "0.29.3" {
		t.Fatalf("bad health: %#v %v", health, err)
	}
	users, err := client.ListUsers(ctx)
	if err != nil || len(users) != 1 || users[0].ID != 42 {
		t.Fatalf("bad users: %#v %v", users, err)
	}
	user, err := client.CreateUser(ctx, "bob", "Bob")
	if err != nil || user.ID != 43 {
		t.Fatalf("bad user: %#v %v", user, err)
	}
	expires := time.Date(2026, 9, 13, 20, 0, 0, 0, time.UTC)
	preAuth, err := client.CreatePreAuthKey(ctx, 42, expires)
	if err != nil || preAuth.ID != 17 || preAuth.Key == "" {
		t.Fatalf("bad preauth key: id %d, key present %v, err %v", preAuth.ID, preAuth.Key != "", err)
	}
	if err := client.ExpirePreAuthKey(ctx, 17); err != nil {
		t.Fatal(err)
	}
	nodes, err := client.ListNodes(ctx, "alice")
	if err != nil || len(nodes) != 1 || nodes[0].ID != 5 || nodes[0].UserID != 42 {
		t.Fatalf("bad nodes: %#v %v", nodes, err)
	}
	if _, err := client.GetNode(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if err := client.ExpireNode(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if err := client.DisableNodeExpiry(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteNode(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if node, err := client.RegisterNode(ctx, "alice", "mkey:phone"); err != nil || node.ID != 6 {
		t.Fatalf("bad registered node: %#v %v", node, err)
	}
	if key, err := client.RotateAPIKey(ctx, expires); err != nil || !strings.HasPrefix(key, "hskey-api-") {
		t.Fatalf("bad rotated key: present %v, err %v", key != "", err)
	}
	if err := client.ExpireAPIKey(ctx, "test-prefix"); err != nil {
		t.Fatal(err)
	}
	keys, err := client.ListAPIKeys(ctx)
	if err != nil || len(keys) != 1 || keys[0].ID != 3 || keys[0].Prefix != "hskey-api-FYQT-7gktHAV-***" || !keys[0].Expiration.Equal(expires) {
		t.Fatalf("bad API key list: %#v %v", keys, err)
	}
	assertRequest(t, requests, "GET", "/api/v1/apikey", nil, nil)

	assertRequest(t, requests, "POST", "/api/v1/user", nil, map[string]any{"name": "bob", "displayName": "Bob"})
	assertRequest(t, requests, "POST", "/api/v1/preauthkey", nil, map[string]any{"user": "42", "reusable": false, "ephemeral": false, "expiration": expires.Format(time.RFC3339), "aclTags": []any{}})
	assertRequest(t, requests, "POST", "/api/v1/preauthkey/expire", nil, map[string]any{"id": "17"})
	assertRequest(t, requests, "GET", "/api/v1/node", url.Values{"user": {"alice"}}, nil)
	assertRequest(t, requests, "POST", "/api/v1/node/5/expire", url.Values{"expiry": {now.Format(time.RFC3339)}}, nil)
	assertRequest(t, requests, "POST", "/api/v1/node/5/expire", url.Values{"disableExpiry": {"true"}}, nil)
	assertRequest(t, requests, "POST", "/api/v1/node/register", url.Values{"user": {"alice"}, "key": {"mkey:phone"}}, nil)
	assertRequest(t, requests, "POST", "/api/v1/apikey", nil, map[string]any{"expiration": expires.Format(time.RFC3339)})
	assertRequest(t, requests, "POST", "/api/v1/apikey/expire", nil, map[string]any{"prefix": "test-prefix"})
}

func assertRequest(t *testing.T, requests []observedRequest, method, path string, query url.Values, body map[string]any) {
	t.Helper()
	for _, request := range requests {
		if request.method == method && request.path == path && (query == nil || reflect.DeepEqual(request.query, query)) && (body == nil || reflect.DeepEqual(request.body, body)) {
			return
		}
	}
	t.Fatalf("request not observed: %s %s query %#v body %#v", method, path, query, body)
}

func TestHealthFallsBackToPublicEndpoint(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		if request.URL.Path == "/api/v1/health" {
			http.NotFound(response, request)
			return
		}
		if request.URL.Path == "/health" {
			_, _ = response.Write([]byte(`{"status":"online"}`))
			return
		}
		if request.URL.Path == "/version" {
			_, _ = response.Write([]byte(`{"version":"v0.29.3"}`))
			return
		}
		if request.URL.Path != "/health" {
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := New(server.URL, testAPIKey, "")
	health, err := client.Health(context.Background())
	if err != nil || !health.OK || health.Version != "0.29.3" {
		t.Fatalf("fallback failed: %#v %v", health, err)
	}
	if !reflect.DeepEqual(paths, []string{"/api/v1/health", "/health", "/version"}) {
		t.Fatalf("unexpected health discovery: %v", paths)
	}
}

func TestHealthRejectsUnsupportedAndMalformedVersions(t *testing.T) {
	for _, test := range []struct {
		version string
		code    string
	}{
		{"v0.28.1", "control_unsupported_version"},
		{"not-a-version", "control_protocol"},
	} {
		t.Run(test.version, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/api/v1/health" {
					_, _ = response.Write([]byte(`{"status":"online"}`))
					return
				}
				if request.URL.Path == "/version" {
					_, _ = response.Write([]byte(`{"version":"` + test.version + `"}`))
					return
				}
				http.NotFound(response, request)
			}))
			defer server.Close()
			client, _ := New(server.URL, testAPIKey, "")
			_, err := client.Health(context.Background())
			if control.Code(err) != test.code {
				t.Fatalf("expected %s, got %v", test.code, err)
			}
		})
	}
}

func TestErrorsHaveStableCodesAndNeverEchoResponseBodies(t *testing.T) {
	for _, test := range []struct {
		status int
		code   string
	}{
		{http.StatusUnauthorized, "control_unauthorized"},
		{http.StatusForbidden, "control_unauthorized"},
		{http.StatusNotFound, "control_not_found"},
		{http.StatusConflict, "control_conflict"},
		{http.StatusInternalServerError, "control_server_error"},
	} {
		t.Run(test.code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				http.Error(response, "hskey-api-must-not-leak", test.status)
			}))
			defer server.Close()
			client, _ := NewWithOptions(server.URL, testAPIKey, "", Options{Sleep: func(context.Context, time.Duration) error { return nil }})
			_, err := client.ListUsers(context.Background())
			if control.Code(err) != test.code || strings.Contains(err.Error(), "must-not-leak") {
				t.Fatalf("bad mapped error: %v", err)
			}
		})
	}
}

func TestRetriesServerFailuresAtDocumentedIntervals(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		attempts++
		if attempts <= 3 {
			http.Error(response, "temporary", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"users":[]}`))
	}))
	defer server.Close()
	var delays []time.Duration
	client, _ := NewWithOptions(server.URL, testAPIKey, "", Options{Sleep: func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}})
	if _, err := client.ListUsers(context.Background()); err != nil {
		t.Fatal(err)
	}
	if attempts != 4 || !reflect.DeepEqual(delays, []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}) {
		t.Fatalf("unexpected retry schedule: attempts %d, delays %v", attempts, delays)
	}
}

func TestServerClockAndProtocolFailures(t *testing.T) {
	serverTime := time.Date(2026, 9, 13, 2, 0, 0, 0, time.UTC)
	localTime := serverTime.Add(-30 * time.Minute)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Date", serverTime.Format(http.TimeFormat))
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"users":"wrong"}`))
	}))
	defer server.Close()
	client, _ := NewWithOptions(server.URL, testAPIKey, "", Options{Now: func() time.Time { return localTime }})
	_, err := client.ListUsers(context.Background())
	if control.Code(err) != "control_protocol" {
		t.Fatalf("expected protocol error, got %v", err)
	}
	if difference := client.ServerNow().Sub(serverTime); difference < -time.Second || difference > time.Second {
		t.Fatalf("server clock not retained: %v", client.ServerNow())
	}
}

func TestTLSFailureAndInputValidation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(`{"users":[]}`))
	}))
	defer server.Close()
	client, _ := NewWithOptions(server.URL, testAPIKey, "", Options{Sleep: func(context.Context, time.Duration) error { return nil }})
	if _, err := client.ListUsers(context.Background()); control.Code(err) != "control_tls" {
		t.Fatalf("expected TLS error, got %v", err)
	}
	for _, rawURL := range []string{"http://example.com", "https://user@example.com", "https://example.com?key=value"} {
		if _, err := New(rawURL, testAPIKey, ""); err == nil {
			t.Fatalf("accepted unsafe URL %q", rawURL)
		}
	}
	plain := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("invalid user reached server") }))
	defer plain.Close()
	valid, _ := New(plain.URL, testAPIKey, "")
	if _, err := valid.CreateUser(context.Background(), "Bad Name", "Bad"); err == nil {
		t.Fatal("accepted invalid user name")
	}
}

func TestClientSatisfiesControlAdmin(t *testing.T) {
	var _ control.ControlAdmin = (*Direct)(nil)
	if !errors.Is(control.AsError("control_unreachable", "offline", true, nil), control.ErrControl) {
		t.Fatal("typed control error does not preserve sentinel")
	}
}
