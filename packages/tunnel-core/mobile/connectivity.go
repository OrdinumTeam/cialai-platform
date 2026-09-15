// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"net"
)

const quicDisableECNEnvironment = "QUIC_GO_DISABLE_ECN"

// prepareQUIC applies the process-local QUIC setup before the first socket is
// opened. quic-go issue 4178 requires ECN to be disabled on Android.
func prepareQUIC(platform string, setenv func(string, string) error) error {
	if platform != "android" {
		return nil
	}
	if err := setenv(quicDisableECNEnvironment, "true"); err != nil {
		return coded("quic_ecn_setup_failed", err)
	}
	return nil
}

// listenUDP opens the socket of the phone QUIC endpoint on every interface,
// so the direct path follows the network the system routes through.
func listenUDP() (net.PacketConn, error) {
	return net.ListenPacket("udp", ":0")
}
