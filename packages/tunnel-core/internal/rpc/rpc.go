// SPDX-License-Identifier: Apache-2.0
// Package rpc defines the bounded JSON-lines protocol shared by the Rust
// supervisor and the Cialai tunnel sidecar.
package rpc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const (
	ProtocolVersion = 1
	MaxLineBytes    = 256 * 1024
)

type Request struct {
	ID      uint64          `json:"id"`
	Command string          `json:"cmd"`
	Args    json.RawMessage `json:"args"`
}

type RPCError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Response struct {
	ID     uint64    `json:"id"`
	OK     bool      `json:"ok"`
	Result any       `json:"result,omitempty"`
	Error  *RPCError `json:"error,omitempty"`
}

type Event struct {
	Name string `json:"event"`
	Data any    `json:"data"`
	Time string `json:"ts"`
}

func Success(id uint64, result any) Response {
	return Response{ID: id, OK: true, Result: result}
}

func Failure(id uint64, code, message string, retryable bool) Response {
	return Response{ID: id, OK: false, Error: &RPCError{Code: code, Message: message, Retryable: retryable}}
}

func NewEvent(name string, data any, now time.Time) (Event, error) {
	if name == "" {
		return Event{}, errors.New("rpc event name is required")
	}
	if _, err := json.Marshal(data); err != nil {
		return Event{}, fmt.Errorf("encode rpc event data: %w", err)
	}
	return Event{Name: name, Data: data, Time: now.UTC().Format(time.RFC3339Nano)}, nil
}

type Reader struct {
	scanner *bufio.Scanner
}

func NewReader(input io.Reader) *Reader {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), MaxLineBytes+1)
	return &Reader{scanner: scanner}
}

func (reader *Reader) Next() (Request, error) {
	if !reader.scanner.Scan() {
		if err := reader.scanner.Err(); err != nil {
			return Request{}, fmt.Errorf("rpc frame exceeds 256 KiB or cannot be read: %w", err)
		}
		return Request{}, io.EOF
	}
	line := reader.scanner.Bytes()
	if len(line) == 0 {
		return Request{}, errors.New("empty rpc frame")
	}
	if len(line) > MaxLineBytes {
		return Request{}, errors.New("rpc frame exceeds 256 KiB")
	}
	var request Request
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return Request{}, fmt.Errorf("decode rpc request: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return Request{}, errors.New("rpc frame contains trailing data")
	}
	if request.ID == 0 || request.Command == "" || request.Args == nil {
		return Request{}, errors.New("rpc request requires id, cmd and args")
	}
	return request, nil
}

type Writer struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func NewWriter(output io.Writer) *Writer {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return &Writer{encoder: encoder}
}

func (writer *Writer) Write(frame any) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if err := writer.encoder.Encode(frame); err != nil {
		return fmt.Errorf("encode rpc frame: %w", err)
	}
	return nil
}
