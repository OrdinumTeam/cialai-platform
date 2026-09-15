// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"
	"unicode/utf8"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/rendezvous"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const (
	// reportBudget bounds the path report sent after a punch, which may run
	// after the punch budget ran out.
	reportBudget   = time.Second
	maxReportBytes = 200
)

// RendezvousPuncher runs step 4 over the rendezvous control channel. For each
// punch it opens the channel on a stream dedicated to it, announces the fresh
// phone candidates, lets rendezvous.Conn.Punch coordinate the opening packets
// and dial the desktop candidates, reports the outcome with ReportPath and
// closes the channel.
type RendezvousPuncher struct {
	// Local is the phone identity announced in hello.
	Local *identity.Identity
	// Endpoint dials the desktop candidates through the socket the phone
	// candidates point at; *direct.Endpoint implements it.
	Endpoint transport.Puncher
	// OpenControl returns an authenticated stream to the desktop dedicated
	// to the control channel, such as a mutual TLS connection over Tor. How
	// the desktop tells it apart from edge connections belongs to the sidecar
	// integration.
	OpenControl func(ctx context.Context, desktop Desktop) (io.ReadWriteCloser, error)
	// Candidates returns the fresh phone candidates, such as the address STUN
	// reflects through Endpoint and the global IPv6 addresses.
	Candidates func(ctx context.Context) ([]pairing.Candidate, error)
	// Handler receives what the desktop sends while the channel is open, such
	// as a renewed reach card for Manager.UpdateCard.
	Handler rendezvous.Handler
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

var _ Puncher = (*RendezvousPuncher)(nil)

// Punch returns the direct session the punch produced.
func (puncher *RendezvousPuncher) Punch(ctx context.Context, desktop Desktop) (transport.Session, error) {
	if puncher.Local == nil || puncher.Endpoint == nil || puncher.OpenControl == nil || puncher.Candidates == nil {
		return nil, errors.New("rendezvous puncher needs the identity, endpoint, control stream and candidates")
	}
	stream, err := puncher.OpenControl(ctx, desktop)
	if err != nil {
		return nil, fmt.Errorf("open control channel: %w", err)
	}
	conn, err := rendezvous.Establish(ctx, stream, rendezvous.Config{
		Role:     identity.RolePhone,
		LocalKey: puncher.Local.PublicKeyString(),
		PeerKey:  identity.EncodePublicKey(desktop.PublicKey),
		Puncher:  puncher.Endpoint,
		Handler:  puncher.Handler,
		Logf:     puncher.Logf,
	})
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	session, err := puncher.run(ctx, conn)
	report := rendezvous.PathReport{Path: transport.NameTor, Reason: reportReason(err)}
	if session != nil {
		report = rendezvous.PathReport{Path: transport.NameDirect, Address: canonicalAddress(session.RemoteAddr())}
	}
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), reportBudget)
	if reportErr := conn.ReportPath(reportCtx, report); reportErr != nil && puncher.Logf != nil {
		puncher.Logf("pathmgr: path report after punch failed: %v", reportErr)
	}
	cancel()
	return session, err
}

func (puncher *RendezvousPuncher) run(ctx context.Context, conn *rendezvous.Conn) (transport.Session, error) {
	list, err := puncher.Candidates(ctx)
	if err != nil {
		return nil, fmt.Errorf("collect phone candidates: %w", err)
	}
	if _, err := conn.SendCandidates(ctx, list, 0); err != nil {
		return nil, fmt.Errorf("send phone candidates: %w", err)
	}
	session, err := conn.Punch(ctx)
	if err != nil {
		return nil, err
	}
	return session, nil
}

// reportReason shortens err to the size a path report accepts.
func reportReason(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if !utf8.ValidString(text) {
		return "punch failed"
	}
	if len(text) <= maxReportBytes {
		return text
	}
	cut := maxReportBytes
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}
