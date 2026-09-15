// SPDX-License-Identifier: Apache-2.0
//go:build netlab

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"sync"
	"time"
)

// lineWriter writes whole lines to one output from many goroutines.
type lineWriter struct {
	mu  sync.Mutex
	out io.Writer
}

func (writer *lineWriter) line(data []byte) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	_, _ = writer.out.Write(append(data, '\n'))
}

func (writer *lineWriter) json(value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		raw, _ = json.Marshal(map[string]string{"error": err.Error()})
	}
	writer.line(raw)
}

// newLineScanner reads JSON lines of up to 1 MiB.
func newLineScanner(input io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	return scanner
}

// splice copies both directions until either side ends, then closes both.
// source replaces left as the reader when bytes were already buffered from it.
func splice(left net.Conn, source io.Reader, right net.Conn) {
	if source == nil {
		source = left
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(right, source)
		closeWrite(right)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(left, right)
		closeWrite(left)
		done <- struct{}{}
	}()
	<-done
	// The other direction gets a moment to drain before both ends close.
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
	_ = left.Close()
	_ = right.Close()
}

func closeWrite(conn net.Conn) {
	if half, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = half.CloseWrite()
		return
	}
	_ = conn.Close()
}

func millis(since time.Time) int64 { return time.Since(since).Milliseconds() }
