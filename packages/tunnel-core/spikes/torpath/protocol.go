// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

type echoMessage struct {
	Sequence int    `json:"sequence"`
	Type     string `json:"type"`
}

func serveConnection(ctx context.Context, raw net.Conn, config *tls.Config) error {
	connection := tls.Server(raw, config)
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if err := connection.HandshakeContext(ctx); err != nil {
		return fmt.Errorf("TLS handshake: %w", err)
	}
	decoder := json.NewDecoder(connection)
	encoder := json.NewEncoder(connection)
	for {
		var message echoMessage
		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read echo: %w", err)
		}
		if message.Type != "ping" {
			return fmt.Errorf("unexpected message type %q", message.Type)
		}
		message.Type = "pong"
		if err := encoder.Encode(message); err != nil {
			return fmt.Errorf("write echo: %w", err)
		}
	}
}

func echoRoundTrip(connection *tls.Conn, sequence int) (time.Duration, error) {
	started := time.Now()
	if err := json.NewEncoder(connection).Encode(echoMessage{Sequence: sequence, Type: "ping"}); err != nil {
		return 0, fmt.Errorf("write echo: %w", err)
	}
	var response echoMessage
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return 0, fmt.Errorf("read echo: %w", err)
	}
	if response.Type != "pong" || response.Sequence != sequence {
		return 0, fmt.Errorf("invalid echo response: %+v", response)
	}
	return time.Since(started), nil
}
