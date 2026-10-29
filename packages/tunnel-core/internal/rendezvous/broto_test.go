package rendezvous

import (
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"testing"
)

func TestBrotoUsesClientControlRole(t *testing.T) {
	keys := newKeys(t)
	reports := make(chan PathReport, 1)
	broto, _ := connPair(t, keys, func(c *Config) { c.Role = identity.RoleBroto }, func(c *Config) {
		c.PeerRole = identity.RoleBroto
		c.Handler.PathReport = func(report PathReport) { reports <- report }
	})
	ctx := testContext(t)
	if err := broto.ReportPath(ctx, PathReport{Path: transport.NameTor}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-reports:
	case <-ctx.Done():
		t.Fatal("Broto path report not delivered")
	}
	if maySend(typeReachUpdate, identity.RoleBroto) || maySend(typePunchAck, identity.RoleBroto) {
		t.Fatal("Broto inherited desktop control verbs")
	}
	if !maySend(typePunchRequest, identity.RoleBroto) {
		t.Fatal("Broto cannot request punch")
	}
}
