// SPDX-License-Identifier: Apache-2.0
// Package control defines the administrative boundary used by pairing and the
// desktop. Implementations can talk directly to Headscale or to a broker.
package control

import (
	"context"
	"errors"
	"strings"
	"time"
)

var ErrControl = errors.New("control service error")

type Error struct {
	Code      string
	Message   string
	Retryable bool
	Cause     error
}

func (problem *Error) Error() string { return problem.Message }

func (problem *Error) Is(target error) bool {
	return target == ErrControl || (problem.Cause != nil && errors.Is(problem.Cause, target))
}

func AsError(code, message string, retryable bool, cause error) error {
	return &Error{Code: code, Message: message, Retryable: retryable, Cause: cause}
}

func Code(err error) string {
	var problem *Error
	if errors.As(err, &problem) {
		return problem.Code
	}
	return ""
}

type ServerInfo struct {
	OK      bool   `json:"ok"`
	Version string `json:"serverVersion,omitempty"`
}

type User struct {
	ID          uint64    `json:"id"`
	Name        string    `json:"name"`
	DisplayName string    `json:"displayName,omitempty"`
	CreatedAt   time.Time `json:"createdAt,omitempty"`
}

type PreAuthKey struct {
	ID         uint64    `json:"id"`
	Key        string    `json:"key"`
	Expiration time.Time `json:"expiration"`
	Used       bool      `json:"used"`
}

type Node struct {
	ID             uint64     `json:"id"`
	NodeKey        string     `json:"nodeKey"`
	MachineKey     string     `json:"machineKey,omitempty"`
	IPAddresses    []string   `json:"ipAddresses,omitempty"`
	Name           string     `json:"name"`
	GivenName      string     `json:"givenName,omitempty"`
	Online         bool       `json:"online"`
	LastSeen       time.Time  `json:"lastSeen,omitempty"`
	Expiry         *time.Time `json:"expiry,omitempty"`
	UserID         uint64     `json:"userId"`
	RegisterMethod string     `json:"registerMethod,omitempty"`
}

// APIKey is the public view Headscale lists for an API key. Prefix keeps the
// server spelling, which ends in -***.
type APIKey struct {
	ID         uint64    `json:"id"`
	Prefix     string    `json:"prefix"`
	Expiration time.Time `json:"expiration"`
	CreatedAt  time.Time `json:"createdAt,omitempty"`
}

const (
	apiKeyMarker       = "hskey-api-"
	apiKeyPrefixLength = 12
)

// APIKeyPrefix returns the public prefix of a Headscale 0.29 key shaped
// hskey-api-{12 character prefix}-{secret}. The base64url prefix may itself
// contain '-', so the fixed length wins over the first separator.
func APIKeyPrefix(apiKey string) string {
	remainder := strings.TrimPrefix(apiKey, apiKeyMarker)
	if len(remainder) > apiKeyPrefixLength && remainder[apiKeyPrefixLength] == '-' {
		return apiKeyMarker + remainder[:apiKeyPrefixLength]
	}
	if separator := strings.IndexByte(remainder, '-'); separator > 0 {
		return apiKeyMarker + remainder[:separator]
	}
	if len(remainder) > apiKeyPrefixLength {
		remainder = remainder[:apiKeyPrefixLength]
	}
	return apiKeyMarker + remainder
}

// SameAPIKeyPrefix compares a prefix listed by Headscale with one computed by
// APIKeyPrefix.
func SameAPIKeyPrefix(listed, prefix string) bool {
	normalize := func(value string) string {
		return strings.TrimPrefix(strings.TrimSuffix(value, "-***"), apiKeyMarker)
	}
	left := normalize(listed)
	return left != "" && left == normalize(prefix)
}

type ControlAdmin interface {
	Health(context.Context) (ServerInfo, error)
	ListUsers(context.Context) ([]User, error)
	CreateUser(context.Context, string, string) (User, error)
	CreatePreAuthKey(context.Context, uint64, time.Time) (PreAuthKey, error)
	ExpirePreAuthKey(context.Context, uint64) error
	ListNodes(context.Context, string) ([]Node, error)
	GetNode(context.Context, uint64) (Node, error)
	ExpireNode(context.Context, uint64) error
	DisableNodeExpiry(context.Context, uint64) error
	DeleteNode(context.Context, uint64) error
	RegisterNode(context.Context, string, string) (Node, error)
	RotateAPIKey(context.Context, time.Time) (string, error)
	ExpireAPIKey(context.Context, string) error
}
