// SPDX-License-Identifier: Apache-2.0
// Package pairing owns QR payloads, one-use pairing sessions and the hashed
// device registry shared by the Cialai edge and mobile tunnel.
package pairing

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	Prefix       = "CIALAI1."
	MaxJSONBytes = 700
)

var (
	userNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	nodeKeyPattern  = regexp.MustCompile(`^nodekey:[0-9a-fA-F]{64}$`)
)

type Desktop struct {
	ID      string `json:"id"`
	Name    string `json:"n"`
	NodeKey string `json:"nk"`
	IP4     string `json:"ip4"`
	Port    int    `json:"p"`
}

type Payload struct {
	Version    int     `json:"v"`
	ControlURL string  `json:"c"`
	UserID     string  `json:"u"`
	UserName   string  `json:"un"`
	AuthKey    *string `json:"k"`
	Desktop    Desktop `json:"d"`
	Secret     string  `json:"s"`
	ExpiresAt  int64   `json:"e"`
	PairID     string  `json:"pid"`
}

type InspectionDesktop struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Port int    `json:"port"`
}

type Inspection struct {
	Version      int               `json:"v"`
	Control      string            `json:"control"`
	UserID       string            `json:"userId"`
	UserName     string            `json:"userName"`
	Desktop      InspectionDesktop `json:"desktop"`
	ExpiresAt    int64             `json:"expiresAt"`
	HasAuthKey   bool              `json:"hasAuthKey"`
	ProfileMatch string            `json:"profileMatch,omitempty"`
}

func Encode(payload Payload, allowLoopbackHTTP bool) (string, error) {
	if err := validatePayload(payload, allowLoopbackHTTP); err != nil {
		return "", err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", wrapError("payload_invalid", "Não foi possível codificar o pareamento.", err)
	}
	if len(raw) > MaxJSONBytes {
		return "", NewError("payload_invalid", "O código de pareamento excede o tamanho permitido.")
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func Decode(text string, allowLoopbackHTTP bool) (Payload, error) {
	if !strings.HasPrefix(text, Prefix) {
		return Payload{}, NewError("payload_invalid", "Este QR code não é um código de pareamento do Cialai.")
	}
	encoded := strings.TrimPrefix(text, Prefix)
	if encoded == "" || len(encoded) > base64.RawURLEncoding.EncodedLen(MaxJSONBytes) {
		return Payload{}, NewError("payload_invalid", "O código de pareamento tem tamanho inválido.")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) > MaxJSONBytes {
		return Payload{}, NewError("payload_invalid", "O código de pareamento está corrompido.")
	}
	var payload Payload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return Payload{}, wrapError("payload_invalid", "O código de pareamento tem campos inválidos.", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Payload{}, NewError("payload_invalid", "O código de pareamento contém dados adicionais.")
	}
	if err := validatePayload(payload, allowLoopbackHTTP); err != nil {
		return Payload{}, err
	}
	return payload, nil
}

func Inspect(text string, now time.Time, allowLoopbackHTTP bool) (Inspection, error) {
	payload, err := Decode(text, allowLoopbackHTTP)
	if err != nil {
		return Inspection{}, err
	}
	if payload.ExpiresAt < now.Add(-60*time.Second).Unix() {
		return Inspection{}, NewError("payload_expired", "Este código expirou. Gere um novo no computador.")
	}
	return Inspection{
		Version: payload.Version, Control: payload.ControlURL, UserID: payload.UserID, UserName: payload.UserName,
		Desktop:   InspectionDesktop{ID: payload.Desktop.ID, Name: payload.Desktop.Name, Port: payload.Desktop.Port},
		ExpiresAt: payload.ExpiresAt, HasAuthKey: payload.AuthKey != nil && *payload.AuthKey != "",
	}, nil
}

func validatePayload(payload Payload, allowLoopbackHTTP bool) error {
	if payload.Version != 1 {
		return NewError("payload_version", "Atualize o Cialai neste celular para usar este código.")
	}
	if err := validateControlURL(payload.ControlURL, allowLoopbackHTTP); err != nil {
		return err
	}
	if _, err := strconv.ParseUint(payload.UserID, 10, 64); err != nil || payload.UserID == "0" || !userNamePattern.MatchString(payload.UserName) {
		return NewError("payload_invalid", "O usuário do código de pareamento é inválido.")
	}
	if payload.AuthKey != nil && (len(*payload.AuthKey) == 0 || len(*payload.AuthKey) > 96 || hasControl(*payload.AuthKey)) {
		return NewError("payload_invalid", "A chave de entrada do código é inválida.")
	}
	if !validEncodedID(payload.Desktop.ID, "d_", 16) || !validName(payload.Desktop.Name, 48) || !nodeKeyPattern.MatchString(payload.Desktop.NodeKey) {
		return NewError("payload_invalid", "A identidade do computador no código é inválida.")
	}
	ip := net.ParseIP(payload.Desktop.IP4)
	if ip == nil || ip.To4() == nil || payload.Desktop.Port < 1 || payload.Desktop.Port > 65535 {
		return NewError("payload_invalid", "O endereço do computador no código é inválido.")
	}
	if !validRawURLBytes(payload.Secret, 32) || !validEncodedID(payload.PairID, "p_", 8) || payload.ExpiresAt <= 0 {
		return NewError("payload_invalid", "A sessão do código de pareamento é inválida.")
	}
	return nil
}

func validateControlURL(raw string, allowLoopbackHTTP bool) error {
	if raw == "" || len(raw) > 128 || !utf8.ValidString(raw) {
		return NewError("payload_invalid", "O endereço do servidor no código é inválido.")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return NewError("payload_invalid", "O endereço do servidor no código é inválido.")
	}
	if parsed.Scheme == "http" {
		ip := net.ParseIP(parsed.Hostname())
		if !allowLoopbackHTTP || ip == nil || !ip.IsLoopback() {
			return NewError("payload_invalid", "O servidor do código precisa usar uma conexão segura.")
		}
	}
	return nil
}

func validName(value string, maximum int) bool {
	return value != "" && utf8.ValidString(value) && utf8.RuneCountInString(value) <= maximum && !hasControl(value)
}

func hasControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

func validEncodedID(value, prefix string, bytesCount int) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	return validRawURLBytes(strings.TrimPrefix(value, prefix), bytesCount)
}

func validRawURLBytes(value string, size int) bool {
	if value == "" || strings.Contains(value, "=") {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == size && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func randomEncoded(reader io.Reader, prefix string, size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := io.ReadFull(reader, buffer); err != nil {
		return "", fmt.Errorf("create random pairing value: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buffer), nil
}
