// SPDX-License-Identifier: Apache-2.0
// Package sidecar composes the tunnel services behind the bounded stdio RPC.
package sidecar

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/control"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/logx"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/rpc"
	"github.com/OrdinumTeam/cialai-platform/packages/tunnel-core/internal/statedir"
)

const (
	Version          = "0.1.0"
	TailscaleVersion = "1.102.0"
)

type Options struct {
	Paths            statedir.Paths
	Input            io.Reader
	Output           io.Writer
	Logger           *logx.Logger
	ParentPID        int
	Alive            func(int) bool
	HandshakeTimeout time.Duration
	AdminFactory     func(string, string, string) (control.ControlAdmin, error)
	// AllowLoopbackHTTP accepts an http control URL on loopback in pairing
	// payloads. Only development and the Docker integration suite set it.
	AllowLoopbackHTTP bool
}

type readResult struct {
	request rpc.Request
	err     error
}

func Serve(parent context.Context, options Options) int {
	if options.Input == nil || options.Output == nil || options.Logger == nil {
		return 2
	}
	if options.HandshakeTimeout <= 0 {
		options.HandshakeTimeout = 5 * time.Second
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	reader := rpc.NewReader(options.Input)
	writer := rpc.NewWriter(options.Output)
	requests := make(chan readResult, 16)
	go func() {
		for {
			request, err := reader.Next()
			requests <- readResult{request: request, err: err}
			if err != nil {
				return
			}
		}
	}()
	hello, _ := rpc.NewEvent("hello", map[string]any{
		"protocol": rpc.ProtocolVersion, "version": Version, "tailscale": TailscaleVersion, "pid": os.Getpid(),
	}, time.Now())
	if err := writer.Write(hello); err != nil {
		return 2
	}

	var first readResult
	timer := time.NewTimer(options.HandshakeTimeout)
	select {
	case first = <-requests:
		if !timer.Stop() {
			<-timer.C
		}
	case <-timer.C:
		return 2
	case <-ctx.Done():
		return 0
	}
	if first.err != nil || first.request.Command != "hello" {
		if first.request.ID != 0 {
			_ = writer.Write(rpc.Failure(first.request.ID, "hello_required", "A primeira solicitação precisa negociar o protocolo.", false))
		}
		return 2
	}
	var helloArgs struct {
		Protocol int `json:"protocol"`
	}
	if err := decodeArgs(first.request.Args, &helloArgs); err != nil || helloArgs.Protocol != rpc.ProtocolVersion {
		_ = writer.Write(rpc.Failure(first.request.ID, "protocol_unsupported", "A versão do protocolo stdio não é compatível.", false))
		return 2
	}
	if err := writer.Write(rpc.Success(first.request.ID, map[string]any{
		"protocol": rpc.ProtocolVersion, "capabilities": []string{"control", "edge", "pairing", "devices"},
	})); err != nil {
		return 2
	}

	runtime := newRuntime(options, writer)
	defer runtime.close()
	done := make(chan struct{})
	var shutdownOnce sync.Once
	requestShutdown := func() {
		shutdownOnce.Do(func() {
			cancel()
			close(done)
		})
	}
	if options.ParentPID > 0 && options.Alive != nil {
		go watchParent(ctx, options.ParentPID, options.Alive, requestShutdown)
	}
	seen := map[uint64]struct{}{first.request.ID: {}}
	var work sync.WaitGroup
	for {
		select {
		case result := <-requests:
			if errors.Is(result.err, io.EOF) {
				work.Wait()
				return 0
			}
			if result.err != nil {
				options.Logger.Error("rpc input failed", logx.Fields{"error": result.err.Error()})
				work.Wait()
				return 2
			}
			request := result.request
			if _, duplicate := seen[request.ID]; duplicate {
				_ = writer.Write(rpc.Failure(request.ID, "request_duplicate", "O identificador desta solicitação já foi usado.", false))
				continue
			}
			seen[request.ID] = struct{}{}
			work.Add(1)
			go func() {
				defer work.Done()
				response, shutdown := runtime.handle(ctx, request)
				_ = writer.Write(response)
				if shutdown {
					requestShutdown()
				}
			}()
		case <-done:
			work.Wait()
			return 0
		case <-ctx.Done():
			work.Wait()
			return 0
		}
	}
}

func watchParent(ctx context.Context, pid int, alive func(int) bool, shutdown func()) {
	if !alive(pid) {
		shutdown()
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if !alive(pid) {
				shutdown()
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
