// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// keepControl runs the rendezvous channel over the control stream of an
// active direct session until the path is released: the phone reports the
// path it uses and the desktop renews the reach card whenever its candidates
// change. The channel is an extra: when it fails the path stays, because QUIC
// finds a dead session by itself, and a session carries one control stream,
// so it is not opened again. Over the fallback the channel lives only while
// RendezvousPuncher punches.
func (m *Manager) keepControl(active *activePath, session transport.ControlSession) {
	defer m.wait.Done()
	conn, err := rendezvous.Open(active.ctx, session, rendezvous.Config{
		Role:     identity.RolePhone,
		LocalKey: m.config.Local.PublicKeyString(),
		Handler:  rendezvous.Handler{ReachUpdate: m.reachUpdate},
		Logf:     m.config.Logf,
	})
	if err != nil {
		if active.ctx.Err() == nil {
			m.config.Logf("pathmgr: control channel over %s unavailable: %v", active.path.Address, err)
		}
		return
	}
	defer conn.Close()
	reportCtx, cancel := context.WithTimeout(active.ctx, reportBudget)
	err = conn.ReportPath(reportCtx, rendezvous.PathReport{Path: transport.NameDirect, Address: active.path.Address})
	cancel()
	if err != nil && active.ctx.Err() == nil {
		m.config.Logf("pathmgr: path report over %s failed: %v", active.path.Address, err)
	}
	select {
	case <-conn.Done():
		if active.ctx.Err() == nil {
			m.config.Logf("pathmgr: control channel over %s ended: %v", active.path.Address, conn.Err())
		}
	case <-active.ctx.Done():
	}
}

// reachUpdate adopts a card the desktop renewed over a control channel.
func (m *Manager) reachUpdate(card candidates.Card) {
	if err := m.UpdateCard(card); err != nil {
		m.config.Logf("pathmgr: renewed reach card refused: %v", err)
	}
}
