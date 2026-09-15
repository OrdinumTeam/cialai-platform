// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// DiagnosticCheck is one line of diagnostics.run.
type DiagnosticCheck struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// Diagnostics is the result of diagnostics.run. OK requires the identity, the
// direct listener and the edge and, unless Tor is disabled, the published
// onion service; LAN, IPv6, mapping, STUN and mDNS only inform which paths
// exist.
type Diagnostics struct {
	OK     bool              `json:"ok"`
	Checks []DiagnosticCheck `json:"checks"`
}

// diagnosticsRun collects the candidates again and probes the gateway before
// reporting, so the checks reflect the network at this moment.
func (runtime *runtimeState) diagnosticsRun(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, invalid("Os argumentos do diagnóstico são inválidos.")
	}
	n := runtime.current()
	probe := "mapeamento desativado"
	if n != nil {
		probeCtx, cancel := context.WithTimeout(ctx, diagnosticsTimeout)
		var wait sync.WaitGroup
		if n.collector != nil {
			wait.Go(func() { _, _ = n.collector.Collect(probeCtx) })
		}
		if n.mapper != nil {
			wait.Go(func() { probe = probeGateway(probeCtx, n.mapper) })
		}
		wait.Wait()
		cancel()
	}
	return buildDiagnostics(runtime.status(), probe), nil
}

func probeGateway(ctx context.Context, mapper candidates.PortMapper) string {
	services, err := mapper.Probe(ctx)
	if err != nil {
		return "o roteador não respondeu a PCP, NAT-PMP ou UPnP"
	}
	var answered []string
	if services.PCP {
		answered = append(answered, "pcp")
	}
	if services.PMP {
		answered = append(answered, "natpmp")
	}
	if services.UPnP {
		answered = append(answered, "upnp")
	}
	if len(answered) == 0 {
		return "o roteador não oferece mapeamento de porta"
	}
	return "o roteador responde a " + strings.Join(answered, ", ")
}

func buildDiagnostics(status NetStatus, probe string) Diagnostics {
	var checks []DiagnosticCheck
	add := func(id string, ok bool, detail string) {
		checks = append(checks, DiagnosticCheck{ID: id, OK: ok, Detail: detail})
	}
	if status.Desktop != nil {
		add("identity", true, status.Desktop.Fingerprint)
	} else {
		add("identity", false, "identidade ainda não carregada")
	}
	listening := status.Direct.State == "listening"
	add("direct_listener", listening, directDetail(status.Direct))

	lan, ipv6 := countKind(status.Direct.Candidates, pairing.CandidateLAN), countKind(status.Direct.Candidates, pairing.CandidateIPv6)
	add("lan_candidates", lan > 0, strconv.Itoa(lan)+" endereços locais")
	add("ipv6", ipv6 > 0, strconv.Itoa(ipv6)+" endereços IPv6 globais")

	mapping := status.Direct.Mapping
	if mapping.Protocol != "none" && mapping.External != "" {
		add("port_mapping", true, mapping.Protocol+" "+mapping.External)
	} else {
		add("port_mapping", false, probe)
	}
	stun := status.Direct.STUN
	stunDetail := stun.State
	if stun.Addr != "" {
		stunDetail = stun.Addr
	}
	add("stun", stun.State == "ok", stunDetail)

	torState := status.Tor
	torEnabled := torState.State != torDisabled
	add("tor_process", torEnabled && torState.State != torFailed, torDetail(torState))
	add("tor_bootstrap", torState.Progress >= 100, strconv.Itoa(torState.Progress)+"%")
	add("onion_published", torState.Published, torState.Onion)
	add("mdns", status.MDNS.State == "announcing", status.MDNS.State)
	edgeRunning := status.Edge.State == "running"
	add("edge", edgeRunning, status.Edge.State)

	ok := status.Desktop != nil && listening && edgeRunning
	if torEnabled {
		ok = ok && torState.State != torFailed && torState.Progress >= 100 && torState.Published
	}
	return Diagnostics{OK: ok, Checks: checks}
}

func directDetail(direct DirectStatus) string {
	if direct.State != "listening" {
		return direct.State
	}
	return fmt.Sprintf("udp %d", direct.Port)
}

func torDetail(status TorStatus) string {
	if status.Error != "" {
		return status.State + " " + status.Error
	}
	return status.State
}

func countKind(list []CandidateStatus, kind string) int {
	count := 0
	for _, candidate := range list {
		if candidate.Kind == kind {
			count++
		}
	}
	return count
}
