// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bytes"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// Network states of NetStatus.State.
const (
	netStopped  = "stopped"
	netStarting = "starting"
	netReady    = "ready"
	netDegraded = "degraded"
	netFailed   = "failed"
)

// Tor states of TorStatus.State.
const (
	torDisabled      = "disabled"
	torStarting      = "starting"
	torBootstrapping = "bootstrapping"
	torReady         = "ready"
	torFailed        = "failed"
)

// DefaultStateInterval is the minimum spacing of net.state events.
const DefaultStateInterval = 250 * time.Millisecond

// NetStatus is the result of net.* and the payload of net.state.
type NetStatus struct {
	State    string         `json:"state"`
	Desktop  *DesktopStatus `json:"desktop,omitempty"`
	Direct   DirectStatus   `json:"direct"`
	Tor      TorStatus      `json:"tor"`
	MDNS     PartStatus     `json:"mdns"`
	Edge     PartStatus     `json:"edge"`
	Sessions SessionCounts  `json:"sessions"`
	Error    *StatusError   `json:"error,omitempty"`
}

type DesktopStatus struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
}

type DirectStatus struct {
	State      string            `json:"state"`
	Port       int               `json:"port"`
	Candidates []CandidateStatus `json:"candidates"`
	Mapping    MappingStatus     `json:"mapping"`
	STUN       STUNStatus        `json:"stun"`
}

type CandidateStatus struct {
	Kind string `json:"kind"`
	Addr string `json:"addr"`
}

type MappingStatus struct {
	Protocol string `json:"protocol"`
	External string `json:"external,omitempty"`
}

type STUNStatus struct {
	State string `json:"state"`
	Addr  string `json:"addr,omitempty"`
}

type TorStatus struct {
	State     string `json:"state"`
	Progress  int    `json:"progress"`
	Onion     string `json:"onion,omitempty"`
	Published bool   `json:"published"`
	Error     string `json:"error,omitempty"`
}

type PartStatus struct {
	State string `json:"state"`
}

type SessionCounts struct {
	Direct int `json:"direct"`
	Tor    int `json:"tor"`
}

type StatusError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func stoppedStatus() NetStatus {
	return NetStatus{
		State: netStopped,
		Direct: DirectStatus{
			State: "stopped", Candidates: []CandidateStatus{},
			Mapping: MappingStatus{Protocol: "none"}, STUN: STUNStatus{State: "disabled"},
		},
		Tor:  TorStatus{State: torDisabled},
		MDNS: PartStatus{State: "disabled"},
		Edge: PartStatus{State: "stopped"},
	}
}

// candidateKind names the QR candidate types as NetStatus shows them: the
// address reflected by STUN is "reflexive".
func candidateKind(kind string) string {
	if kind == pairing.CandidateSTUN {
		return "reflexive"
	}
	return kind
}

// mappingProtocol names the gateway protocols as NetStatus shows them.
func mappingProtocol(protocol string) string {
	switch protocol {
	case "pcp", "upnp":
		return protocol
	case "pmp", "natpmp":
		return "natpmp"
	default:
		return "none"
	}
}

func directCandidates(snapshot candidates.Snapshot) []CandidateStatus {
	list := make([]CandidateStatus, 0, len(snapshot.Candidates))
	for _, candidate := range snapshot.Candidates {
		list = append(list, CandidateStatus{Kind: candidateKind(candidate.Type), Addr: candidate.Address.String()})
	}
	return list
}

// torStatus maps the supervisor phases of tor.Desktop to TorStatus. A
// restarting Tor shows as starting with the reason of the last exit; ready
// means bootstrap reached 100 %, and published that the descriptor was
// uploaded in the current run.
func torStatus(state tor.State) TorStatus {
	status := TorStatus{Onion: state.Address, Progress: state.Bootstrap.Progress, Published: state.Published}
	switch state.Phase {
	case tor.PhaseStarting:
		status.State = torStarting
		status.Progress = 0
	case tor.PhaseRestarting:
		status.State = torStarting
		status.Progress = 0
		status.Error = "tor_restarting"
	case tor.PhaseBootstrapping:
		status.State = torBootstrapping
		if status.Progress >= 100 {
			status.State = torReady
		}
	case tor.PhasePublished:
		status.State = torReady
		status.Progress = 100
	case tor.PhaseFailed:
		status.State = torFailed
		status.Error = "tor_failed"
		if errors.Is(state.Err, tor.ErrAddressMismatch) {
			status.Error = "tor_address_mismatch"
		}
	default:
		status.State = torDisabled
		status.Progress = 0
		status.Published = false
	}
	if status.Error == "" && state.Bootstrap.Warning != "" && status.State == torBootstrapping {
		status.Error = "tor_bootstrap_warning"
	}
	return status
}

// deriveState applies the NetStatus rules: failed without a direct listener
// or edge, degraded when ready with a failing part, ready otherwise.
func deriveState(status NetStatus) string {
	if status.Direct.State != "listening" || status.Edge.State == "failed" {
		return netFailed
	}
	if status.Edge.State != "running" {
		return netStarting
	}
	if status.Tor.State == torFailed || status.Tor.Error == "tor_restarting" || status.MDNS.State == "failed" {
		return netDegraded
	}
	return netReady
}

// stateEmitter coalesces net.state events: at most one per interval, always
// with the latest status and never twice the same status in a row.
type stateEmitter struct {
	interval time.Duration
	build    func() NetStatus
	emit     func(NetStatus)
	kick     chan struct{}
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once

	mu   sync.Mutex
	last []byte
}

func newStateEmitter(interval time.Duration, build func() NetStatus, emit func(NetStatus)) *stateEmitter {
	if interval <= 0 {
		interval = DefaultStateInterval
	}
	emitter := &stateEmitter{
		interval: interval, build: build, emit: emit,
		kick: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}),
	}
	go emitter.run()
	return emitter
}

func (emitter *stateEmitter) trigger() {
	select {
	case emitter.kick <- struct{}{}:
	default:
	}
}

func (emitter *stateEmitter) run() {
	defer close(emitter.done)
	var sent time.Time
	for {
		select {
		case <-emitter.kick:
		case <-emitter.stop:
			return
		}
		if wait := emitter.interval - time.Since(sent); !sent.IsZero() && wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-timer.C:
			case <-emitter.stop:
				timer.Stop()
				return
			}
		}
		// A kick that arrived while waiting is already covered by this build.
		select {
		case <-emitter.kick:
		default:
		}
		if emitter.send() {
			sent = time.Now()
		}
	}
}

// send emits the current status unless it equals the last one sent.
func (emitter *stateEmitter) send() bool {
	status := emitter.build()
	encoded, err := json.Marshal(status)
	if err != nil {
		return false
	}
	emitter.mu.Lock()
	defer emitter.mu.Unlock()
	if bytes.Equal(encoded, emitter.last) {
		return false
	}
	emitter.last = encoded
	emitter.emit(status)
	return true
}

// close stops the loop and sends the final status at once, so the last
// change before the sidecar exits is not held back by the interval.
func (emitter *stateEmitter) close() {
	emitter.once.Do(func() {
		close(emitter.stop)
		<-emitter.done
		emitter.send()
	})
}
