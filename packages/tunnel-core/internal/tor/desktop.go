// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/cretz/bine/process"
)

const (
	defaultShutdownGrace = 3 * time.Second
	defaultRestartMin    = time.Second
	defaultRestartMax    = 30 * time.Second
	defaultControlWait   = 30 * time.Second
	// stableRun resets the restart delay: a Tor that stayed up this long is
	// not crash looping.
	stableRun    = time.Minute
	onionKeyName = "onion.key"
)

var (
	ErrDesktopClosed      = errors.New("tor desktop controller is closed")
	ErrClientAuthDisabled = errors.New("client authorization keys need ClientAuthV3 enabled")
	ErrClientAuthKeys     = errors.New("ClientAuthV3 needs at least one client key")
)

// Phase is the coarse lifecycle of the desktop onion service, the source of
// the tor.state event.
type Phase string

const (
	PhaseStarting      Phase = "starting"
	PhaseBootstrapping Phase = "bootstrapping"
	PhasePublished     Phase = "published"
	PhaseRestarting    Phase = "restarting"
	PhaseFailed        Phase = "failed"
	PhaseStopped       Phase = "stopped"
)

// State is a snapshot of the desktop onion service.
type State struct {
	Phase Phase
	// Address is computed from the persisted key before Tor starts and never
	// changes for that key.
	Address string
	// Registered is the address Tor returned from ADD_ONION in the current
	// run; it is empty until then and always equals Address.
	Registered string
	Bootstrap  Bootstrap
	// Published is set once Tor uploaded a descriptor in the current run.
	Published bool
	Restarts  int
	// RetryIn is the delay before the next start while restarting.
	RetryIn time.Duration
	// Err is the last failure; it is cleared when the service is published.
	Err error
}

// DesktopConfig configures the supervised Tor child of the desktop sidecar.
type DesktopConfig struct {
	// Executable is the bundled tor binary, laid out as in the Expert Bundle.
	Executable string
	// Dir is statedir.Paths.Tor; torrc, the data directory and the cookie
	// live there.
	Dir string
	// OnionKeyPath defaults to Dir/onion.key, statedir.Paths.OnionKey.
	OnionKeyPath string
	// OwnerPID is written as __OwningControllerProcess; it defaults to this
	// process.
	OwnerPID int
	// Output receives Tor's log; nil discards it.
	Output io.Writer
	// OnState is called serially after every change, by the supervisor and
	// finally by Close. It must return quickly.
	OnState func(State)
	// ClientAuthV3 is the flag that restricts the service to ClientAuthKeys,
	// base32 x25519 public keys. It is off by default: phones authenticate
	// through the pinned TLS session.
	ClientAuthV3   bool
	ClientAuthKeys []string

	// Test seams.
	creator       process.Creator
	env           []string
	shutdownGrace time.Duration
	restartMin    time.Duration
	restartMax    time.Duration
	controlWait   time.Duration
}

// Desktop supervises the Tor child that hosts the single-hop onion service.
// Connections to <Address>:443 arrive on Listener as plain TCP; the caller
// wraps them in TLS.
type Desktop struct {
	config   DesktopConfig
	key      *OnionKey
	listener net.Listener
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}

	mu      sync.Mutex
	state   State
	changed chan struct{}
	pid     int

	// stopErr is written by the supervisor before done closes.
	stopErr   error
	closeOnce sync.Once
	closeErr  error
}

// StartDesktop loads or creates the onion key, opens the loopback listener
// and starts the supervisor. It returns before Tor bootstraps: Address is
// usable at once, and progress is reported through OnState and WaitState.
func StartDesktop(config DesktopConfig) (*Desktop, error) {
	if err := config.normalize(); err != nil {
		return nil, err
	}
	key, _, err := LoadOrCreateOnionKey(config.OnionKeyPath, nil)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for onion connections: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	desktop := &Desktop{
		config:   config,
		key:      key,
		listener: listener,
		ctx:      ctx,
		cancel:   cancel,
		done:     make(chan struct{}),
		changed:  make(chan struct{}),
		state:    State{Phase: PhaseStarting, Address: key.Address()},
	}
	go desktop.supervise()
	return desktop, nil
}

func (config *DesktopConfig) normalize() error {
	if !filepath.IsAbs(config.Executable) {
		return errors.New("tor executable path must be absolute")
	}
	if info, err := os.Stat(config.Executable); err != nil {
		return fmt.Errorf("tor executable: %w", err)
	} else if !info.Mode().IsRegular() {
		return errors.New("tor executable is not a regular file")
	}
	if !filepath.IsAbs(config.Dir) {
		return errors.New("tor state directory must be absolute")
	}
	if config.OnionKeyPath == "" {
		config.OnionKeyPath = filepath.Join(config.Dir, onionKeyName)
	}
	if config.OwnerPID == 0 {
		config.OwnerPID = os.Getpid()
	}
	if config.ClientAuthV3 && len(config.ClientAuthKeys) == 0 {
		return ErrClientAuthKeys
	}
	if !config.ClientAuthV3 && len(config.ClientAuthKeys) > 0 {
		return ErrClientAuthDisabled
	}
	for _, key := range config.ClientAuthKeys {
		if err := validateClientAuthKey(key); err != nil {
			return err
		}
	}
	if config.creator == nil {
		config.creator = execCreator{path: config.Executable, output: config.Output, env: config.env}
	}
	defaults := []struct {
		value    *time.Duration
		fallback time.Duration
	}{
		{&config.shutdownGrace, defaultShutdownGrace},
		{&config.restartMin, defaultRestartMin},
		{&config.restartMax, defaultRestartMax},
		{&config.controlWait, defaultControlWait},
	}
	for _, item := range defaults {
		if *item.value <= 0 {
			*item.value = item.fallback
		}
	}
	return nil
}

// Address is the onion host name derived from the persisted key.
func (desktop *Desktop) Address() string { return desktop.key.Address() }

// Listener delivers the connections Tor forwards from <Address>:443. It is
// owned by the Desktop and closed by Close.
func (desktop *Desktop) Listener() net.Listener { return desktop.listener }

// State returns the latest snapshot.
func (desktop *Desktop) State() State {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return desktop.state
}

// WaitState blocks until match accepts the current snapshot. A stopped or
// failed controller ends the wait with an error, since it will not change.
func (desktop *Desktop) WaitState(ctx context.Context, match func(State) bool) (State, error) {
	for {
		desktop.mu.Lock()
		state, changed := desktop.state, desktop.changed
		desktop.mu.Unlock()
		if match(state) {
			return state, nil
		}
		switch state.Phase {
		case PhaseStopped:
			return state, ErrDesktopClosed
		case PhaseFailed:
			return state, state.Err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return state, ctx.Err()
		}
	}
}

// Close stops Tor with SIGNAL SHUTDOWN, kills it when it is still running
// after the grace period, and closes the listener. It returns
// ErrShutdownTimeout when Tor had to be killed.
func (desktop *Desktop) Close() error {
	desktop.closeOnce.Do(func() {
		desktop.cancel()
		<-desktop.done
		err := desktop.stopErr
		if closeErr := desktop.listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			err = errors.Join(err, closeErr)
		}
		desktop.closeErr = err
		desktop.update(func(state *State) {
			state.Phase = PhaseStopped
			state.Registered = ""
			state.Published = false
			state.RetryIn = 0
		})
	})
	return desktop.closeErr
}

func (desktop *Desktop) currentPID() int {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return desktop.pid
}

func (desktop *Desktop) update(change func(*State)) {
	desktop.mu.Lock()
	change(&desktop.state)
	snapshot := desktop.state
	close(desktop.changed)
	desktop.changed = make(chan struct{})
	desktop.mu.Unlock()
	if desktop.config.OnState != nil {
		desktop.config.OnState(snapshot)
	}
}

// supervise runs Tor until Close, restarting it with a doubling delay from
// restartMin to restartMax. An address mismatch is permanent and stops it.
func (desktop *Desktop) supervise() {
	defer close(desktop.done)
	delay := desktop.config.restartMin
	for restarts := 0; ; restarts++ {
		started := time.Now()
		err := desktop.runOnce(restarts)
		if desktop.ctx.Err() != nil {
			return
		}
		if errors.Is(err, ErrAddressMismatch) {
			desktop.update(func(state *State) {
				state.Phase = PhaseFailed
				state.Registered = ""
				state.Published = false
				state.Err = err
			})
			return
		}
		if time.Since(started) >= stableRun {
			delay = desktop.config.restartMin
		}
		retry := delay
		desktop.update(func(state *State) {
			state.Phase = PhaseRestarting
			state.Registered = ""
			state.Published = false
			state.RetryIn = retry
			state.Err = err
		})
		timer := time.NewTimer(retry)
		select {
		case <-desktop.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		delay = min(delay*2, desktop.config.restartMax)
	}
}

// runOnce launches Tor, registers the onion with the network still disabled,
// enables the network and follows events until Tor or the controller stops.
func (desktop *Desktop) runOnce(restarts int) error {
	desktop.update(func(state *State) {
		state.Phase = PhaseStarting
		state.Registered = ""
		state.Published = false
		state.Bootstrap = Bootstrap{}
		state.Restarts = restarts
		state.RetryIn = 0
	})
	setup, cancelSetup := context.WithTimeout(desktop.ctx, 2*desktop.config.controlWait)
	defer cancelSetup()
	running, err := launch(setup, launchSpec{
		creator:     desktop.config.creator,
		executable:  desktop.config.Executable,
		dir:         desktop.config.Dir,
		role:        roleService,
		ownerPID:    desktop.config.OwnerPID,
		controlWait: desktop.config.controlWait,
	})
	if err != nil {
		return err
	}
	desktop.mu.Lock()
	desktop.pid = running.pid
	desktop.mu.Unlock()
	defer func() {
		stopErr := running.stop(desktop.config.shutdownGrace)
		desktop.mu.Lock()
		desktop.pid = 0
		desktop.mu.Unlock()
		if desktop.ctx.Err() != nil {
			desktop.stopErr = stopErr
		}
	}()

	registered, status, err := desktop.register(setup, running.control)
	if err != nil {
		return err
	}
	cancelSetup()
	desktop.update(func(state *State) {
		state.Phase = PhaseBootstrapping
		state.Registered = registered
		state.Bootstrap = status
	})
	for {
		event, err := running.control.nextEvent(desktop.ctx)
		if err != nil {
			return errors.Join(err, running.exitError())
		}
		desktop.handleEvent(event)
	}
}

// register returns the address Tor published, after checking it against the
// address computed from the key.
func (desktop *Desktop) register(ctx context.Context, control *controlConn) (string, Bootstrap, error) {
	if _, err := control.do(ctx, "SETEVENTS STATUS_CLIENT HS_DESC"); err != nil {
		return "", Bootstrap{}, fmt.Errorf("subscribe to tor events: %w", err)
	}
	request := onionRequest{
		key:          desktop.key,
		virtualPort:  OnionPort,
		target:       desktop.listener.Addr().String(),
		nonAnonymous: true,
	}
	if desktop.config.ClientAuthV3 {
		request.clientAuthV3 = desktop.config.ClientAuthKeys
	}
	serviceID, err := control.addOnion(ctx, request)
	if err != nil {
		return "", Bootstrap{}, err
	}
	if serviceID != desktop.key.ServiceID() {
		return "", Bootstrap{}, fmt.Errorf("%w: tor returned %s.onion, key is %s", ErrAddressMismatch, serviceID, desktop.key.Address())
	}
	if _, err := control.do(ctx, "SETCONF DisableNetwork=0"); err != nil {
		return "", Bootstrap{}, fmt.Errorf("enable tor network: %w", err)
	}
	status, err := control.bootstrap(ctx)
	return serviceID + onionSuffix, status, err
}

// handleEvent follows STATUS_CLIENT bootstrap progress and HS_DESC uploads of
// this service's descriptor.
func (desktop *Desktop) handleEvent(event string) {
	name, body, _ := strings.Cut(event, " ")
	switch name {
	case "STATUS_CLIENT":
		status, ok := parseBootstrap(body)
		if !ok {
			return
		}
		desktop.update(func(state *State) {
			// Events queued before the GETINFO snapshot must not move the
			// progress backwards; warnings are always reported.
			if status.Progress >= state.Bootstrap.Progress || status.Warning != "" {
				state.Bootstrap = status
			}
		})
	case "HS_DESC":
		words, _ := parseArguments(body)
		if len(words) < 2 || words[0] != "UPLOADED" || words[1] != desktop.key.ServiceID() {
			return
		}
		desktop.update(func(state *State) {
			state.Phase = PhasePublished
			state.Published = true
			state.Err = nil
		})
	}
}
