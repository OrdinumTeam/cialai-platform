// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/quic-go/quic-go"
)

func quicConfig() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout: 5 * time.Second,
		MaxIdleTimeout:       15 * time.Second,
		KeepAlivePeriod:      5 * time.Second,
		Allow0RTT:            false,
	}
}

func udpPort(address net.Addr) (uint16, error) {
	udp, ok := address.(*net.UDPAddr)
	if !ok || udp.Port < 1 || udp.Port > 65535 {
		return 0, fmt.Errorf("unexpected UDP address %q", address)
	}
	return uint16(udp.Port), nil
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
