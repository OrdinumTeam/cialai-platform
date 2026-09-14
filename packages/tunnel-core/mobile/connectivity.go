// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"os"
	"runtime"

	"github.com/quic-go/quic-go"
	netproxy "golang.org/x/net/proxy"
)

const quicDisableECNEnvironment = "QUIC_GO_DISABLE_ECN"

type connectivityDependencies struct {
	Platform             string `json:"platform"`
	QUICVersion          string `json:"quicVersion"`
	SOCKS5               bool   `json:"socks5"`
	AndroidECNWorkaround bool   `json:"androidEcnWorkaround"`
}

// ConnectivityDependenciesJSON is the minimal gomobile surface used by the
// connectivity spike. It proves that quic-go and the SOCKS5 dialer compile
// into the mobile binding without opening a network connection.
//
// quic-go issue 4178 requires ECN to be disabled on Android before the first
// QUIC socket is opened. Calling this function performs that process-local
// setup on Android.
func ConnectivityDependenciesJSON() (string, error) {
	return connectivityDependenciesJSON(runtime.GOOS, os.Setenv)
}

func connectivityDependenciesJSON(platform string, setenv func(string, string) error) (string, error) {
	androidECNWorkaround := platform == "android"
	if androidECNWorkaround {
		if err := setenv(quicDisableECNEnvironment, "true"); err != nil {
			return "", coded("quic_ecn_setup_failed", err)
		}
	}
	quicConfig := quic.Config{Versions: []quic.Version{quic.Version1}}
	socksDialer, err := netproxy.SOCKS5("tcp", "127.0.0.1:9", nil, netproxy.Direct)
	if err != nil {
		return "", coded("socks5_setup_failed", err)
	}
	return marshalJSON(connectivityDependencies{
		Platform:             platform,
		QUICVersion:          quicConfig.Versions[0].String(),
		SOCKS5:               socksDialer != nil,
		AndroidECNWorkaround: androidECNWorkaround,
	})
}
