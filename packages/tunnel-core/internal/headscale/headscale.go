// SPDX-License-Identifier: Apache-2.0
// Package headscale implements ControlAdmin against Headscale 0.29 REST.
package headscale

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/control"
)

const maxResponseBytes = 1 << 20

var userNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

type Options struct {
	HTTPClient *http.Client
	Now        func() time.Time
	Sleep      func(context.Context, time.Duration) error
}

type Direct struct {
	base       *url.URL
	apiKey     string
	httpClient *http.Client
	now        func() time.Time
	sleep      func(context.Context, time.Duration) error
	clockMu    sync.RWMutex
	clockSkew  time.Duration
}

func New(controlURL, apiKey, caFile string) (*Direct, error) {
	return NewWithOptions(controlURL, apiKey, caFile, Options{})
}

func NewWithOptions(controlURL, apiKey, caFile string, options Options) (*Direct, error) {
	base, err := parseControlURL(controlURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("Headscale API key is required")
	}
	client := options.HTTPClient
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		if caFile != "" {
			certificate, err := os.ReadFile(caFile)
			if err != nil {
				return nil, errors.New("cannot read Headscale CA file")
			}
			roots, err := x509.SystemCertPool()
			if err != nil || roots == nil {
				roots = x509.NewCertPool()
			}
			if !roots.AppendCertsFromPEM(certificate) {
				return nil, errors.New("Headscale CA file contains no certificate")
			}
			transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
		}
		client = &http.Client{Transport: transport, Timeout: 15 * time.Second}
	} else if caFile != "" {
		return nil, errors.New("CA file cannot be combined with a custom HTTP client")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	sleep := options.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	return &Direct{base: base, apiKey: apiKey, httpClient: client, now: now, sleep: sleep}, nil
}

func parseControlURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("valid Headscale URL is required")
	}
	if parsed.Scheme == "http" {
		ip := net.ParseIP(parsed.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("Headscale URL must use HTTPS outside loopback")
		}
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (client *Direct) ServerNow() time.Time {
	client.clockMu.RLock()
	skew := client.clockSkew
	client.clockMu.RUnlock()
	return client.now().Add(skew)
}

func (client *Direct) rememberServerTime(header string) {
	serverTime, err := http.ParseTime(header)
	if err != nil {
		return
	}
	client.clockMu.Lock()
	client.clockSkew = serverTime.Sub(client.now())
	client.clockMu.Unlock()
}

func (client *Direct) endpoint(path string, query url.Values) string {
	target := *client.base
	target.Path = strings.TrimRight(client.base.Path, "/") + path
	target.RawQuery = query.Encode()
	return target.String()
}

func (client *Direct) do(ctx context.Context, method, path string, query url.Values, body, output any) error {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return control.AsError("control_protocol", "Não foi possível codificar a solicitação ao servidor.", false, err)
		}
	}
	delays := [...]time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	for attempt := 0; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, client.endpoint(path, query), bytes.NewReader(encoded))
		if err != nil {
			return control.AsError("control_protocol", "Não foi possível montar a solicitação ao servidor.", false, err)
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Authorization", "Bearer "+client.apiKey)
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response, requestErr := client.httpClient.Do(request)
		if requestErr != nil {
			problem := transportError(requestErr)
			if control.Code(problem) != "control_unreachable" || attempt == len(delays) {
				return problem
			}
			if err := client.sleep(ctx, delays[attempt]); err != nil {
				return control.AsError("control_unreachable", "A conexão com o servidor foi interrompida.", true, err)
			}
			continue
		}
		client.rememberServerTime(response.Header.Get("Date"))
		responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
		_ = response.Body.Close()
		if readErr != nil {
			return control.AsError("control_protocol", "O servidor devolveu uma resposta incompleta.", false, readErr)
		}
		if len(responseBody) > maxResponseBytes {
			return control.AsError("control_protocol", "A resposta do servidor excedeu o limite permitido.", false, nil)
		}
		if response.StatusCode >= 500 && attempt < len(delays) {
			if err := client.sleep(ctx, delays[attempt]); err != nil {
				return control.AsError("control_unreachable", "A conexão com o servidor foi interrompida.", true, err)
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return statusError(response.StatusCode)
		}
		if output == nil {
			return nil
		}
		if len(bytes.TrimSpace(responseBody)) == 0 {
			return control.AsError("control_protocol", "O servidor devolveu uma resposta vazia.", false, nil)
		}
		if err := json.Unmarshal(responseBody, output); err != nil {
			return control.AsError("control_protocol", "O servidor devolveu dados incompatíveis.", false, err)
		}
		return nil
	}
}

func transportError(err error) error {
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &unknownAuthority) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return control.AsError("control_tls", "Não foi possível validar o certificado do servidor. Confira o certificado, o relógio e a autoridade configurada.", false, err)
	}
	return control.AsError("control_unreachable", "Não foi possível alcançar o servidor Headscale.", true, err)
}

func statusError(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return control.AsError("control_unauthorized", "A chave da API do Headscale não foi aceita.", false, nil)
	case http.StatusNotFound:
		return control.AsError("control_not_found", "O recurso não existe no servidor Headscale.", false, nil)
	case http.StatusConflict:
		return control.AsError("control_conflict", "O recurso já existe no servidor Headscale.", false, nil)
	default:
		if status >= 500 {
			return control.AsError("control_server_error", "O servidor Headscale não concluiu a operação.", true, nil)
		}
		return control.AsError("control_protocol", fmt.Sprintf("O servidor Headscale respondeu com HTTP %d.", status), false, nil)
	}
}

func (client *Direct) Health(ctx context.Context) (control.ServerInfo, error) {
	var response struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	err := client.do(ctx, http.MethodGet, "/api/v1/health", nil, nil, &response)
	if control.Code(err) == "control_not_found" {
		err = client.do(ctx, http.MethodGet, "/health", nil, nil, &response)
	}
	if err != nil {
		return control.ServerInfo{}, err
	}
	if response.Version == "" {
		var version struct {
			Version string `json:"version"`
		}
		if err := client.do(ctx, http.MethodGet, "/version", nil, nil, &version); err != nil {
			return control.ServerInfo{}, err
		}
		response.Version = version.Version
	}
	version, supported, valid := supportedVersion(response.Version)
	if !valid {
		return control.ServerInfo{}, control.AsError("control_protocol", "O servidor não informou uma versão válida do Headscale.", false, nil)
	}
	if !supported {
		return control.ServerInfo{}, control.AsError("control_unsupported_version", "O Cialai requer Headscale 0.29 ou mais recente.", false, nil)
	}
	return control.ServerInfo{OK: response.Status == "" || strings.EqualFold(response.Status, "online") || strings.EqualFold(response.Status, "ok"), Version: version}, nil
}

func supportedVersion(raw string) (version string, supported, valid bool) {
	version = strings.TrimPrefix(strings.TrimSpace(raw), "v")
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return version, false, false
	}
	major, majorErr := strconv.Atoi(parts[0])
	minor, minorErr := strconv.Atoi(parts[1])
	if majorErr != nil || minorErr != nil || major < 0 || minor < 0 {
		return version, false, false
	}
	return version, major > 0 || minor >= 29, true
}

func (client *Direct) ListUsers(ctx context.Context) ([]control.User, error) {
	var response struct {
		Users []wireUser `json:"users"`
	}
	if err := client.do(ctx, http.MethodGet, "/api/v1/user", nil, nil, &response); err != nil {
		return nil, err
	}
	users := make([]control.User, len(response.Users))
	for index, user := range response.Users {
		users[index] = user.control()
	}
	return users, nil
}

func (client *Direct) CreateUser(ctx context.Context, name, displayName string) (control.User, error) {
	if !userNamePattern.MatchString(name) {
		return control.User{}, errors.New("Headscale user name must match lowercase letters, numbers and hyphens")
	}
	var response struct {
		User wireUser `json:"user"`
	}
	body := map[string]any{"name": name, "displayName": displayName}
	if err := client.do(ctx, http.MethodPost, "/api/v1/user", nil, body, &response); err != nil {
		return control.User{}, err
	}
	return response.User.control(), nil
}

func (client *Direct) CreatePreAuthKey(ctx context.Context, userID uint64, expiresAt time.Time) (control.PreAuthKey, error) {
	var response struct {
		Key wirePreAuthKey `json:"preAuthKey"`
	}
	body := map[string]any{
		"user": strconv.FormatUint(userID, 10), "reusable": false, "ephemeral": false,
		"expiration": expiresAt.UTC().Format(time.RFC3339), "aclTags": []string{},
	}
	if err := client.do(ctx, http.MethodPost, "/api/v1/preauthkey", nil, body, &response); err != nil {
		return control.PreAuthKey{}, err
	}
	return response.Key.control(), nil
}

func (client *Direct) ExpirePreAuthKey(ctx context.Context, id uint64) error {
	return client.do(ctx, http.MethodPost, "/api/v1/preauthkey/expire", nil, map[string]any{"id": strconv.FormatUint(id, 10)}, nil)
}

func (client *Direct) ListNodes(ctx context.Context, userName string) ([]control.Node, error) {
	var response struct {
		Nodes []wireNode `json:"nodes"`
	}
	if err := client.do(ctx, http.MethodGet, "/api/v1/node", url.Values{"user": {userName}}, nil, &response); err != nil {
		return nil, err
	}
	nodes := make([]control.Node, len(response.Nodes))
	for index, node := range response.Nodes {
		nodes[index] = node.control()
	}
	return nodes, nil
}

func (client *Direct) GetNode(ctx context.Context, id uint64) (control.Node, error) {
	var response struct {
		Node wireNode `json:"node"`
	}
	if err := client.do(ctx, http.MethodGet, "/api/v1/node/"+strconv.FormatUint(id, 10), nil, nil, &response); err != nil {
		return control.Node{}, err
	}
	return response.Node.control(), nil
}

func (client *Direct) ExpireNode(ctx context.Context, id uint64) error {
	query := url.Values{"expiry": {client.ServerNow().UTC().Format(time.RFC3339)}}
	err := client.do(ctx, http.MethodPost, "/api/v1/node/"+strconv.FormatUint(id, 10)+"/expire", query, nil, nil)
	if control.Code(err) == "control_not_found" {
		return nil
	}
	return err
}

func (client *Direct) DisableNodeExpiry(ctx context.Context, id uint64) error {
	query := url.Values{"disableExpiry": {"true"}}
	err := client.do(ctx, http.MethodPost, "/api/v1/node/"+strconv.FormatUint(id, 10)+"/expire", query, nil, nil)
	if control.Code(err) == "control_not_found" {
		return nil
	}
	return err
}

func (client *Direct) DeleteNode(ctx context.Context, id uint64) error {
	err := client.do(ctx, http.MethodDelete, "/api/v1/node/"+strconv.FormatUint(id, 10), nil, nil, nil)
	if control.Code(err) == "control_not_found" {
		return nil
	}
	return err
}

func (client *Direct) RegisterNode(ctx context.Context, userName, machineKey string) (control.Node, error) {
	var response struct {
		Node wireNode `json:"node"`
	}
	query := url.Values{"user": {userName}, "key": {machineKey}}
	if err := client.do(ctx, http.MethodPost, "/api/v1/node/register", query, nil, &response); err != nil {
		return control.Node{}, err
	}
	return response.Node.control(), nil
}

func (client *Direct) RotateAPIKey(ctx context.Context, expiresAt time.Time) (string, error) {
	var response struct {
		APIKey string `json:"apiKey"`
		Key    string `json:"key"`
	}
	if err := client.do(ctx, http.MethodPost, "/api/v1/apikey", nil, map[string]any{"expiration": expiresAt.UTC().Format(time.RFC3339)}, &response); err != nil {
		return "", err
	}
	if response.APIKey != "" {
		return response.APIKey, nil
	}
	if response.Key != "" {
		return response.Key, nil
	}
	return "", control.AsError("control_protocol", "O servidor não devolveu a nova chave da API.", false, nil)
}

func (client *Direct) ExpireAPIKey(ctx context.Context, prefix string) error {
	return client.do(ctx, http.MethodPost, "/api/v1/apikey/expire", nil, map[string]any{"prefix": prefix}, nil)
}

// ListAPIKeys returns public metadata only; Headscale never lists secrets.
func (client *Direct) ListAPIKeys(ctx context.Context) ([]control.APIKey, error) {
	var response struct {
		APIKeys []wireAPIKey `json:"apiKeys"`
	}
	if err := client.do(ctx, http.MethodGet, "/api/v1/apikey", nil, nil, &response); err != nil {
		return nil, err
	}
	keys := make([]control.APIKey, 0, len(response.APIKeys))
	for _, key := range response.APIKeys {
		keys = append(keys, control.APIKey{ID: uint64(key.ID), Prefix: key.Prefix, Expiration: time.Time(key.Expiration), CreatedAt: time.Time(key.CreatedAt)})
	}
	return keys, nil
}

type wireAPIKey struct {
	ID         wireID   `json:"id"`
	Prefix     string   `json:"prefix"`
	Expiration wireTime `json:"expiration"`
	CreatedAt  wireTime `json:"createdAt"`
	LastSeen   wireTime `json:"lastSeen"`
}

type wireID uint64

func (id *wireID) UnmarshalJSON(data []byte) error {
	value := strings.Trim(string(data), `"`)
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return err
	}
	*id = wireID(parsed)
	return nil
}

type wireUser struct {
	ID          wireID   `json:"id"`
	Name        string   `json:"name"`
	DisplayName string   `json:"displayName"`
	CreatedAt   wireTime `json:"createdAt"`
}

func (user wireUser) control() control.User {
	return control.User{ID: uint64(user.ID), Name: user.Name, DisplayName: user.DisplayName, CreatedAt: time.Time(user.CreatedAt)}
}

type wirePreAuthKey struct {
	ID         wireID   `json:"id"`
	Key        string   `json:"key"`
	Expiration wireTime `json:"expiration"`
	Used       bool     `json:"used"`
}

func (key wirePreAuthKey) control() control.PreAuthKey {
	return control.PreAuthKey{ID: uint64(key.ID), Key: key.Key, Expiration: time.Time(key.Expiration), Used: key.Used}
}

type wireNode struct {
	ID          wireID    `json:"id"`
	NodeKey     string    `json:"nodeKey"`
	MachineKey  string    `json:"machineKey"`
	IPAddresses []string  `json:"ipAddresses"`
	Name        string    `json:"name"`
	GivenName   string    `json:"givenName"`
	Online      bool      `json:"online"`
	LastSeen    wireTime  `json:"lastSeen"`
	Expiry      *wireTime `json:"expiry"`
	User        struct {
		ID wireID `json:"id"`
	} `json:"user"`
	RegisterMethod string `json:"registerMethod"`
}

func (node wireNode) control() control.Node {
	var expiry *time.Time
	if node.Expiry != nil {
		value := time.Time(*node.Expiry)
		expiry = &value
	}
	return control.Node{
		ID: uint64(node.ID), NodeKey: node.NodeKey, MachineKey: node.MachineKey,
		IPAddresses: append([]string(nil), node.IPAddresses...), Name: node.Name,
		GivenName: node.GivenName, Online: node.Online, LastSeen: time.Time(node.LastSeen),
		Expiry: expiry, UserID: uint64(node.User.ID), RegisterMethod: node.RegisterMethod,
	}
}

type wireTime time.Time

func (value *wireTime) UnmarshalJSON(data []byte) error {
	if bytes.Equal(data, []byte("null")) || bytes.Equal(data, []byte(`""`)) {
		*value = wireTime(time.Time{})
		return nil
	}
	var parsed time.Time
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	*value = wireTime(parsed)
	return nil
}
