// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/control"
	edge "github.com/Cialai/cialai/packages/tunnel-core/internal/edge/edgev1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/headscale"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/node"
	pairing "github.com/Cialai/cialai/packages/tunnel-core/internal/pairing/pairingv1"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

type runtimeState struct {
	mu           sync.Mutex
	logger       *logx.Logger
	writer       *rpc.Writer
	paths        statedir.Paths
	adminFactory func(string, string, string) (control.ControlAdmin, error)
	admin        control.ControlAdmin
	controlURL   string
	caFile       string
	node         *node.Manager
	sessions     *pairing.Sessions
	devices      *pairing.Registry
	edge         *edge.Server
	edgeListener net.Listener
	desktop      pairing.DesktopIdentity
	edgePort     int
	userID       string
	userName     string
	approvals    *approvalQueue
}

func newRuntime(options Options, writer *rpc.Writer) *runtimeState {
	factory := options.AdminFactory
	if factory == nil {
		factory = func(rawURL, apiKey, caFile string) (control.ControlAdmin, error) {
			return headscale.New(rawURL, apiKey, caFile)
		}
	}
	runtime := &runtimeState{
		logger: options.Logger, writer: writer, paths: options.Paths, adminFactory: factory,
		node:     node.NewTSNetManager(options.Logger.Logf("info"), options.Logger.Logf("debug")),
		sessions: pairing.NewSessions(nil, nil, options.AllowLoopbackHTTP),
	}
	runtime.approvals = newApprovalQueue(runtime.emit)
	return runtime
}

func (runtime *runtimeState) handle(ctx context.Context, request rpc.Request) (rpc.Response, bool) {
	switch request.Command {
	case "logs.tail":
		var args struct {
			Lines int `json:"lines"`
		}
		if err := decodeArgs(request.Args, &args); err != nil {
			return failure(request.ID, "args_invalid", "Os argumentos de logs são inválidos.", false), false
		}
		return rpc.Success(request.ID, map[string]any{"lines": runtime.logger.Tail(args.Lines)}), false
	case "shutdown":
		if err := decodeArgs(request.Args, &struct{}{}); err != nil {
			return failure(request.ID, "args_invalid", "Os argumentos de desligamento são inválidos.", false), false
		}
		return rpc.Success(request.ID, map[string]any{}), true
	default:
		return runtime.handleService(ctx, request), false
	}
}

func (runtime *runtimeState) close() {
	runtime.mu.Lock()
	edgeServer := runtime.edge
	edgeListener := runtime.edgeListener
	runtime.edge = nil
	runtime.edgeListener = nil
	runtime.mu.Unlock()
	if edgeServer != nil {
		_ = edgeServer.Close(context.Background())
	}
	if edgeListener != nil {
		_ = edgeListener.Close()
	}
	_ = runtime.node.Down()
}

func decodeArgs(raw json.RawMessage, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing RPC arguments")
	}
	return nil
}

func failure(id uint64, code, message string, retryable bool) rpc.Response {
	return rpc.Failure(id, code, message, retryable)
}
