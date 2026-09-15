// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rpc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
)

// legacyRegistrySuffix names the devices.json v1 kept aside when the v2
// registry starts empty; its phones must pair again.
const legacyRegistrySuffix = ".v1-legacy"

type runtimeState struct {
	logger        *logx.Logger
	writer        *rpc.Writer
	paths         statedir.Paths
	torExecutable string
	seams         NetworkConfig
	sessions      *pairing.Sessions
	approvals     *approvalQueue
	emitter       *stateEmitter

	// commandMu serializes the commands that change the network, the
	// identity or the registry.
	commandMu sync.Mutex

	// mu guards the fields below, read by events from other goroutines.
	mu        sync.Mutex
	identity  *identity.Identity
	desktop   pairing.Desktop
	devices   *pairing.Registry
	net       *network
	lastError *StatusError
	lastTor   TorStatus
}

func newRuntime(options Options, writer *rpc.Writer) *runtimeState {
	runtime := &runtimeState{
		logger: options.Logger, writer: writer, paths: options.Paths,
		torExecutable: options.TorExecutable, seams: options.Network,
		sessions: pairing.NewSessions(nil, nil),
	}
	runtime.approvals = newApprovalQueue(runtime.emit)
	runtime.emitter = newStateEmitter(options.Network.StateInterval, runtime.status, func(status NetStatus) {
		runtime.emit("net.state", status)
	})
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

// close stops the network, Tor included, and sends the final net.state.
func (runtime *runtimeState) close() {
	runtime.commandMu.Lock()
	runtime.stopNetwork()
	runtime.commandMu.Unlock()
	runtime.emitter.close()
}

// current returns the running network, or nil.
func (runtime *runtimeState) current() *network {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.net
}

// status builds NetStatus from the running network and the last start error.
func (runtime *runtimeState) status() NetStatus {
	runtime.mu.Lock()
	n, desktopIdentity, desktop, lastError := runtime.net, runtime.identity, runtime.desktop, runtime.lastError
	runtime.mu.Unlock()
	status := stoppedStatus()
	if n != nil {
		status = n.status()
		desktop = n.currentDesktop()
		status.State = deriveState(status)
	} else if lastError != nil {
		status.State = netFailed
		status.Direct.State = "failed"
	}
	if desktopIdentity != nil {
		status.Desktop = &DesktopStatus{
			ID: desktopIdentity.ID(), Name: desktop.Name,
			PublicKey: desktopIdentity.PublicKeyString(), Fingerprint: desktopIdentity.Fingerprint(),
		}
	}
	if n == nil || status.State == netFailed {
		status.Error = lastError
	}
	return status
}

func (runtime *runtimeState) torStatus() TorStatus {
	if n := runtime.current(); n != nil {
		return n.status().Tor
	}
	return TorStatus{State: torDisabled}
}

// openIdentity loads identity.key and identity.json v2 from the state
// directory, creating them on first use, and opens the v2 device registry.
// A devices.json v1 is moved aside: v1 phones must pair again.
func (runtime *runtimeState) openIdentity(name string) error {
	loaded, record, _, err := identity.Open(identity.Options{Role: identity.RoleDesktop, Dir: runtime.paths.Root, Name: name})
	if err != nil {
		return &serviceError{code: "identity_failed", message: "A identidade deste computador não pôde ser carregada.", cause: err}
	}
	desktop := pairing.Desktop{ID: loaded.ID(), Name: name, PublicKey: loaded.PublicKeyString()}
	runtime.mu.Lock()
	devices := runtime.devices
	runtime.mu.Unlock()
	if devices == nil {
		devices, err = runtime.openRegistry(pairing.DesktopIdentity{ID: loaded.ID(), Name: name, CreatedAt: record.CreatedAt})
		if err != nil {
			return err
		}
	}
	runtime.mu.Lock()
	runtime.identity = loaded
	runtime.desktop = desktop
	runtime.devices = devices
	runtime.mu.Unlock()
	return nil
}

func (runtime *runtimeState) openRegistry(desktop pairing.DesktopIdentity) (*pairing.Registry, error) {
	devices, err := pairing.OpenRegistry(runtime.paths, desktop, nil, nil)
	if errors.Is(err, pairing.ErrLegacyRegistry) {
		legacy := runtime.paths.Devices + legacyRegistrySuffix
		if renameErr := os.Rename(runtime.paths.Devices, legacy); renameErr != nil {
			return nil, &serviceError{code: "registry_legacy", message: err.Error(), cause: renameErr}
		}
		runtime.logger.Warn("devices.json v1 moved aside; phones must pair again", logx.Fields{"path": legacy})
		devices, err = pairing.OpenRegistry(runtime.paths, desktop, nil, nil)
	}
	if err != nil {
		return nil, &serviceError{code: "registry_failed", message: "O registro de celulares deste computador não pôde ser lido.", cause: err}
	}
	return devices, nil
}

func (runtime *runtimeState) registry() *pairing.Registry {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.devices
}

// stopNetwork closes the running network; commandMu must be held.
func (runtime *runtimeState) stopNetwork() {
	runtime.mu.Lock()
	n := runtime.net
	runtime.mu.Unlock()
	if n == nil {
		return
	}
	n.close()
	runtime.mu.Lock()
	runtime.net = nil
	runtime.mu.Unlock()
	runtime.emitTor(TorStatus{State: torDisabled, Onion: n.onionAddress})
	runtime.emitter.trigger()
}

// emitTor sends tor.state unless it repeats the last one.
func (runtime *runtimeState) emitTor(status TorStatus) {
	runtime.mu.Lock()
	same := runtime.lastTor == status
	runtime.lastTor = status
	runtime.mu.Unlock()
	if !same {
		runtime.emit("tor.state", status)
	}
}

func (runtime *runtimeState) emit(name string, data any) {
	event, err := rpc.NewEvent(name, data, time.Now())
	if err == nil {
		_ = runtime.writer.Write(event)
	}
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

type serviceError struct {
	code      string
	message   string
	retryable bool
	cause     error
}

func (problem *serviceError) Error() string {
	if problem.cause != nil {
		return fmt.Sprintf("%s: %v", problem.message, problem.cause)
	}
	return problem.message
}

func (problem *serviceError) Unwrap() error { return problem.cause }

func invalid(message string) error {
	return &serviceError{code: "args_invalid", message: message}
}
