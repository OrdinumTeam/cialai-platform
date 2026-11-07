// SPDX-License-Identifier: Apache-2.0
package identity

import (
	"bytes"
	"crypto/ed25519"
	"testing"
)

func TestRecordingClientAcceptsAnyHostKeyAndRecordsIt(t *testing.T) {
	broto := mustGenerate(t, RoleBroto)
	for _, host := range []*Identity{mustGenerate(t, RoleDesktop), mustGenerate(t, RoleDesktop)} {
		var recorded ed25519.PublicKey
		config, err := RecordingClientConfig(broto, func(key ed25519.PublicKey) { recorded = key })
		if err != nil {
			t.Fatal(err)
		}
		if config.MinVersion != 0x0304 || config.MaxVersion != 0x0304 || !config.SessionTicketsDisabled || len(config.NextProtos) != 1 || config.NextProtos[0] != ALPN {
			t.Fatalf("recording config is weaker than the pinned one: %+v", config)
		}
		serverConfig, _ := ServerConfig(host)
		clientResult, serverResult := handshake(t, config, serverConfig)
		if clientResult.err != nil || serverResult.err != nil {
			t.Fatalf("handshake failed: client=%v server=%v", clientResult.err, serverResult.err)
		}
		if !bytes.Equal(recorded, host.PublicKey()) {
			t.Fatal("the recorded key is not the key of the host")
		}
		peer, err := ServerPeer(serverResult.state, nil)
		if err != nil || peer.Key != broto.PublicKeyString() {
			t.Fatalf("the host did not see the Broto certificate: %+v %v", peer, err)
		}
	}
	if _, err := RecordingClientConfig(nil, func(ed25519.PublicKey) {}); err == nil {
		t.Fatal("recording config without identity was accepted")
	}
	if _, err := RecordingClientConfig(broto, nil); err == nil {
		t.Fatal("recording config without recorder was accepted")
	}
}
