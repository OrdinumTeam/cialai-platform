// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"time"

	"tailscale.com/net/netmon"
	"tailscale.com/net/portmapper"
	"tailscale.com/net/portmapper/portmappertype"
	"tailscale.com/types/logger"
	"tailscale.com/util/eventbus"
)

type mappingRuntime struct {
	bus        *eventbus.Bus
	monitor    *netmon.Monitor
	client     *portmapper.Client
	subscriber *eventbus.Subscriber[portmappertype.Mapping]
	subClient  *eventbus.Client
}

func (r *mappingRuntime) close() {
	if r == nil {
		return
	}
	if r.subscriber != nil {
		r.subscriber.Close()
	}
	if r.subClient != nil {
		r.subClient.Close()
	}
	if r.client != nil {
		_ = r.client.Close()
	}
	if r.monitor != nil {
		_ = r.monitor.Close()
	}
	if r.bus != nil {
		r.bus.Close()
	}
}

func collectNetwork(ctx context.Context, mux *packetMux, localPort uint16, stunServers []string) (networkProbe, *mappingRuntime) {
	started := time.Now()
	probe := networkProbe{}

	var mapping portmappertype.Mapping
	var mappingErr error
	var protocols protocolProbe
	var runtime *mappingRuntime
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		mapping, protocols, runtime, mappingErr = collectMapping(ctx, localPort)
	}()

	probe.STUN = make([]stunProbe, len(stunServers))
	for index, server := range stunServers {
		index, server := index, server
		wait.Add(1)
		go func() {
			defer wait.Done()
			requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			reply := mux.stun(requestCtx, server)
			result := stunProbe{Server: server}
			if reply.err != nil {
				result.Error = reply.err.Error()
			} else {
				result.ReflexiveAddr = reply.address
				result.RTTMillis = reply.rtt.Milliseconds()
			}
			probe.STUN[index] = result
		}()
	}
	wait.Wait()

	probe.Protocols = protocols
	if mapping.External.IsValid() {
		probe.Mapping = mapping.External.String()
		probe.MappingType = mapping.Type
	}
	if mappingErr != nil {
		probe.MappingError = mappingErr.Error()
	}
	probe.CollectionMS = time.Since(started).Milliseconds()
	return probe, runtime
}

func collectMapping(ctx context.Context, localPort uint16) (portmappertype.Mapping, protocolProbe, *mappingRuntime, error) {
	bus := eventbus.New()
	monitor, err := netmon.New(bus, logger.Discard)
	if err != nil {
		bus.Close()
		return portmappertype.Mapping{}, protocolProbe{}, nil, fmt.Errorf("start network monitor: %w", err)
	}
	monitor.Start()
	subClient := bus.Client("directpath-spike")
	subscriber := eventbus.Subscribe[portmappertype.Mapping](subClient)
	client := portmapper.NewClient(portmapper.Config{
		EventBus: bus,
		Logf:     logger.Discard,
		NetMon:   monitor,
	})
	client.SetGatewayLookupFunc(monitor.GatewayAndSelfIP)
	client.SetLocalPort(localPort)
	runtime := &mappingRuntime{
		bus: bus, monitor: monitor, client: client,
		subscriber: subscriber, subClient: subClient,
	}

	available, probeErr := client.Probe(ctx)
	protocols := protocolProbe{PCP: available.PCP, PMP: available.PMP, UPnP: available.UPnP}
	if probeErr != nil {
		return portmappertype.Mapping{}, protocols, runtime, fmt.Errorf("probe port mapping: %w", probeErr)
	}
	if !available.PCP && !available.PMP && !available.UPnP {
		return portmappertype.Mapping{}, protocols, runtime, errors.New("no PCP, NAT-PMP or UPnP service discovered")
	}
	if external, ok := client.GetCachedMappingOrStartCreatingOne(); ok {
		return portmappertype.Mapping{External: external, Type: inferMappingType(protocols)}, protocols, runtime, nil
	}
	select {
	case mapping := <-subscriber.Events():
		return mapping, protocols, runtime, nil
	case <-ctx.Done():
		return portmappertype.Mapping{}, protocols, runtime, fmt.Errorf("create port mapping: %w", ctx.Err())
	}
}

func inferMappingType(protocols protocolProbe) string {
	var names []string
	if protocols.PCP {
		names = append(names, "pcp")
	}
	if protocols.PMP {
		names = append(names, "nat-pmp")
	}
	if protocols.UPnP {
		names = append(names, "upnp")
	}
	if len(names) == 1 {
		return names[0]
	}
	return "cached-or-unknown"
}

func candidatesFromProbe(probe networkProbe) []candidate {
	var result []candidate
	if probe.Mapping != "" {
		result = append(result, candidate{Type: "mapped", Address: probe.Mapping, Protocol: probe.MappingType})
	}
	for _, item := range probe.STUN {
		if item.ReflexiveAddr == "" {
			continue
		}
		if parsed, err := netip.ParseAddrPort(item.ReflexiveAddr); err == nil && parsed.Port() != 0 {
			result = appendCandidate(result, candidate{Type: "stun", Address: parsed.String(), Protocol: item.Server})
		}
	}
	return result
}
