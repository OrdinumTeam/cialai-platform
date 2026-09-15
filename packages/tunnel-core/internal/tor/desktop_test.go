// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cretz/bine/process"
	ps "github.com/mitchellh/go-ps"
)

type stateLog struct {
	mu     sync.Mutex
	states []State
}

func (log *stateLog) record(state State) {
	log.mu.Lock()
	log.states = append(log.states, state)
	log.mu.Unlock()
}

func (log *stateLog) snapshot() []State {
	log.mu.Lock()
	defer log.mu.Unlock()
	return slices.Clone(log.states)
}

func fakeDesktopConfig(t *testing.T, creator process.Creator, log *stateLog) DesktopConfig {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return DesktopConfig{
		Executable:    executable,
		Dir:           filepath.Join(t.TempDir(), "tor"),
		OnState:       log.record,
		creator:       creator,
		restartMin:    10 * time.Millisecond,
		restartMax:    40 * time.Millisecond,
		shutdownGrace: time.Second,
		controlWait:   5 * time.Second,
	}
}

func startTestDesktop(t *testing.T, config DesktopConfig) *Desktop {
	t.Helper()
	desktop, err := StartDesktop(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = desktop.Close() })
	return desktop
}

func waitDesktop(t *testing.T, desktop *Desktop, match func(State) bool) State {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state, err := desktop.WaitState(ctx, match)
	if err != nil {
		t.Fatalf("waiting for state: %v (last %+v)", err, state)
	}
	return state
}

func published(state State) bool { return state.Published }

func TestDesktopPublishesComputedAddress(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	log := &stateLog{}
	config := fakeDesktopConfig(t, creator, log)
	desktop := startTestDesktop(t, config)

	stored, created, err := LoadOrCreateOnionKey(filepath.Join(config.Dir, "onion.key"), nil)
	if err != nil || created {
		t.Fatalf("key was not persisted before start: created=%v err=%v", created, err)
	}
	if desktop.Address() != stored.Address() || desktop.State().Address != stored.Address() {
		t.Fatalf("address %s, persisted key gives %s", desktop.Address(), stored.Address())
	}

	state := waitDesktop(t, desktop, published)
	if state.Phase != PhasePublished || state.Registered != desktop.Address() || state.Bootstrap.Progress != 100 || state.Err != nil {
		t.Fatalf("published state = %+v", state)
	}
	tor := creator.waitInstance(t, 0)
	commands := tor.received()
	verbs := make([]string, 0, len(commands))
	for _, command := range commands {
		verb, _, _ := strings.Cut(command, " ")
		verbs = append(verbs, verb)
	}
	wantVerbs := []string{"PROTOCOLINFO", "AUTHCHALLENGE", "AUTHENTICATE", "TAKEOWNERSHIP", "SETEVENTS", "ADD_ONION", "SETCONF", "GETINFO"}
	if !slices.Equal(verbs, wantVerbs) {
		t.Fatalf("commands = %q", verbs)
	}
	if commands[4] != "SETEVENTS STATUS_CLIENT HS_DESC" || commands[6] != "SETCONF DisableNetwork=0" {
		t.Fatalf("commands = %q", commands)
	}
	wantOnion := " Flags=NonAnonymous Port=443," + desktop.Listener().Addr().String()
	if !strings.HasSuffix(commands[5], wantOnion) {
		t.Fatalf("ADD_ONION = %q, want suffix %q", commands[5], wantOnion)
	}
	torrc, err := os.ReadFile(filepath.Join(config.Dir, "torrc"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"DisableNetwork 1\n", "__OwningControllerProcess " + strconv.Itoa(os.Getpid()) + "\n", "HiddenServiceSingleHopMode 1\n"} {
		if !strings.Contains(string(torrc), want) {
			t.Fatalf("torrc lacks %q", want)
		}
	}
	phases := []Phase{}
	for _, seen := range log.snapshot() {
		if len(phases) == 0 || phases[len(phases)-1] != seen.Phase {
			phases = append(phases, seen.Phase)
		}
	}
	if !slices.Equal(phases, []Phase{PhaseStarting, PhaseBootstrapping, PhasePublished}) {
		t.Fatalf("phases = %v", phases)
	}

	if err := desktop.Close(); err != nil {
		t.Fatalf("Close = %v", err)
	}
	tor.waitExit(t)
	if !slices.Contains(tor.received(), "SIGNAL SHUTDOWN") {
		t.Fatal("Close did not send SIGNAL SHUTDOWN")
	}
	if state := desktop.State(); state.Phase != PhaseStopped || state.Published || state.Address != stored.Address() {
		t.Fatalf("state after Close = %+v", state)
	}
	if _, err := desktop.Listener().Accept(); err == nil {
		t.Fatal("listener still open after Close")
	}
	if err := desktop.Close(); err != nil {
		t.Fatalf("second Close = %v", err)
	}
	if _, err := desktop.WaitState(context.Background(), published); !errors.Is(err, ErrDesktopClosed) {
		t.Fatalf("WaitState after Close = %v", err)
	}
}

func TestDesktopIgnoresOtherServiceUploads(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{noUpload: true})
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, &stateLog{}))
	state := waitDesktop(t, desktop, func(state State) bool { return state.Bootstrap.Progress == 100 })
	time.Sleep(50 * time.Millisecond)
	if state = desktop.State(); state.Published || state.Phase != PhaseBootstrapping {
		t.Fatalf("another service's upload published this one: %+v", state)
	}
}

func TestDesktopKeepsAddressAcrossStarts(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	config := fakeDesktopConfig(t, creator, &stateLog{})
	addresses := []string{}
	for range 2 {
		desktop, err := StartDesktop(config)
		if err != nil {
			t.Fatal(err)
		}
		state := waitDesktop(t, desktop, published)
		addresses = append(addresses, state.Registered)
		if err := desktop.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if addresses[0] == "" || addresses[0] != addresses[1] {
		t.Fatalf("addresses across starts = %q", addresses)
	}
	for index := range 2 {
		creator.waitInstance(t, index).waitExit(t)
	}
}

func TestDesktopRestartsAfterTorExits(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	log := &stateLog{}
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, log))
	first := waitDesktop(t, desktop, published)
	creator.waitInstance(t, 0).crash()
	second := waitDesktop(t, desktop, func(state State) bool { return state.Restarts == 1 && state.Published })
	if second.Registered != first.Registered || second.Err != nil {
		t.Fatalf("after restart = %+v, before %+v", second, first)
	}
	var restarting *State
	for _, state := range log.snapshot() {
		if state.Phase == PhaseRestarting {
			restarting = &state
			break
		}
	}
	if restarting == nil || restarting.RetryIn != 10*time.Millisecond || !errors.Is(restarting.Err, ErrControlClosed) || restarting.Published {
		t.Fatalf("restarting state = %+v", restarting)
	}
	if creator.count() != 2 {
		t.Fatalf("started %d tors, want 2", creator.count())
	}
}

func TestDesktopRestartDelayDoublesUpToLimit(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{failStart: true})
	log := &stateLog{}
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, log))
	waitDesktop(t, desktop, func(state State) bool { return state.Restarts >= 5 })
	if err := desktop.Close(); err != nil {
		t.Fatal(err)
	}
	delays := []time.Duration{}
	for _, state := range log.snapshot() {
		if state.Phase == PhaseRestarting {
			delays = append(delays, state.RetryIn)
			if state.Err == nil || !strings.Contains(state.Err.Error(), "permission denied") {
				t.Fatalf("restart error = %v", state.Err)
			}
		}
	}
	want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond, 40 * time.Millisecond}
	if len(delays) < len(want) || !slices.Equal(delays[:len(want)], want) {
		t.Fatalf("restart delays = %v", delays)
	}
}

func TestDesktopStopsOnAddressMismatch(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{wrongServiceID: true})
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, &stateLog{}))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state, err := desktop.WaitState(ctx, published)
	if !errors.Is(err, ErrAddressMismatch) || state.Phase != PhaseFailed {
		t.Fatalf("state %+v err %v", state, err)
	}
	creator.waitInstance(t, 0).waitExit(t)
	time.Sleep(100 * time.Millisecond)
	if creator.count() != 1 {
		t.Fatalf("mismatch restarted tor %d times", creator.count()-1)
	}
	if err := desktop.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopKillsTorThatIgnoresShutdown(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{ignoreShutdown: true})
	config := fakeDesktopConfig(t, creator, &stateLog{})
	config.shutdownGrace = 200 * time.Millisecond
	desktop := startTestDesktop(t, config)
	waitDesktop(t, desktop, published)
	started := time.Now()
	if err := desktop.Close(); !errors.Is(err, ErrShutdownTimeout) {
		t.Fatalf("Close = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("Close took %s", elapsed)
	}
	tor := creator.waitInstance(t, 0)
	tor.waitExit(t)
	if err := tor.Wait(); err == nil || !strings.Contains(err.Error(), "killed") {
		t.Fatalf("tor exit = %v, want killed", err)
	}
}

func TestDesktopClientAuthFlag(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	config := fakeDesktopConfig(t, creator, &stateLog{})
	clientKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.ToLower(serviceIDEncoding.EncodeToString(clientKey.PublicKey().Bytes()))

	withoutFlag := config
	withoutFlag.ClientAuthKeys = []string{encoded}
	if _, err := StartDesktop(withoutFlag); !errors.Is(err, ErrClientAuthDisabled) {
		t.Fatalf("keys without flag err = %v", err)
	}
	withoutKeys := config
	withoutKeys.ClientAuthV3 = true
	if _, err := StartDesktop(withoutKeys); !errors.Is(err, ErrClientAuthKeys) {
		t.Fatalf("flag without keys err = %v", err)
	}
	badKey := withoutKeys
	badKey.ClientAuthKeys = []string{"not-a-key"}
	if _, err := StartDesktop(badKey); !errors.Is(err, ErrInvalidClientKey) {
		t.Fatalf("bad key err = %v", err)
	}

	config.ClientAuthV3 = true
	config.ClientAuthKeys = []string{encoded}
	desktop := startTestDesktop(t, config)
	waitDesktop(t, desktop, published)
	addOnion := ""
	for _, command := range creator.waitInstance(t, 0).received() {
		if strings.HasPrefix(command, "ADD_ONION ") {
			addOnion = command
		}
	}
	if !strings.Contains(addOnion, " Flags=NonAnonymous,V3Auth ") || !strings.HasSuffix(addOnion, " ClientAuthV3="+encoded) {
		t.Fatalf("ADD_ONION = %q", addOnion)
	}
}

func TestDesktopConfigValidation(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cases := map[string]DesktopConfig{
		"relative executable": {Executable: "tor", Dir: dir},
		"missing executable":  {Executable: filepath.Join(dir, "missing"), Dir: dir},
		"directory as binary": {Executable: dir, Dir: dir},
		"relative state":      {Executable: executable, Dir: "tor"},
	}
	for name, config := range cases {
		if desktop, err := StartDesktop(config); err == nil {
			_ = desktop.Close()
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestDesktopExecChildLeavesNoOrphan runs the fake tor as a real child process
// through bine's process.Creator, kills it to force a restart, and checks that
// no child survives Close.
func TestDesktopExecChildLeavesNoOrphan(t *testing.T) {
	log := &stateLog{}
	config := fakeDesktopConfig(t, nil, log)
	config.creator = nil
	// A race-enabled child sleeps 1 s at exit by default, longer than the
	// shutdown grace used here.
	config.env = []string{fakeTorEnv + "=1", "GORACE=atexit_sleep_ms=0"}
	desktop := startTestDesktop(t, config)
	waitDesktop(t, desktop, published)
	firstPID := desktop.currentPID()
	if firstPID <= 0 || firstPID == os.Getpid() {
		t.Fatalf("child pid = %d", firstPID)
	}
	child, err := os.FindProcess(firstPID)
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Kill(); err != nil {
		t.Fatal(err)
	}
	waitDesktop(t, desktop, func(state State) bool { return state.Restarts == 1 && state.Published })
	secondPID := desktop.currentPID()
	if secondPID <= 0 || secondPID == firstPID {
		t.Fatalf("restarted child pid = %d, first %d", secondPID, firstPID)
	}
	if err := desktop.Close(); err != nil {
		t.Fatalf("Close = %v", err)
	}
	for _, pid := range []int{firstPID, secondPID} {
		if found, err := ps.FindProcess(pid); err != nil || found != nil {
			t.Fatalf("child %d still exists (%v, err %v)", pid, found, err)
		}
	}
}
