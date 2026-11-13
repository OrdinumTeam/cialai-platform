// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"bytes"
	"context"
	"errors"
	"net/netip"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

func TestDialCandidatesRecordReturnsTheHostKeyWithoutAPin(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	h.gate.active.Store(true)
	broto := newTestEndpoint(t, mustIdentity(t, identity.RoleBroto))
	serverAddr := addrPort(t, h.listener.Addr())
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	session, key, err := broto.DialCandidatesRecord(ctx, []netip.AddrPort{closedUDPAddr(t), serverAddr})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(key, h.desktop.PublicKey()) || session.PeerKey() != h.desktop.PublicKeyString() {
		t.Fatal("the recorded key is not the key of the host")
	}
	if accepted := h.accept(t); accepted.Registered() {
		t.Fatal("the host registered an unknown Broto key")
	}
	_ = session.Close()

	pinned, err := broto.DialCandidates(ctx, []netip.AddrPort{serverAddr}, key)
	if err != nil {
		t.Fatalf("the recorded key does not pin the same host: %v", err)
	}
	_ = pinned.Close()
	if _, _, err := broto.DialCandidatesRecord(ctx, nil); !errors.Is(err, transport.ErrNoCandidates) {
		t.Fatalf("empty dial: %v", err)
	}
}
