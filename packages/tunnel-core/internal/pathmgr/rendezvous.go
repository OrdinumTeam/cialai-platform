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
// punch it opens the channel on a connection dedicated to it, gathering the
// phone candidates meanwhile, announces them, lets rendezvous.Conn.Punch
// coordinate the opening packets and dial the desktop candidates, reports the
// outcome with ReportPath and closes the channel. The desktop sends its reach
// card right after hello, so every punch also renews the card through
// Handler.ReachUpdate.
type RendezvousPuncher struct {
	// Local is the phone identity announced in hello.
	Local *identity.Identity
	// Endpoint dials the desktop candidates through the socket the phone
	// candidates point at; *direct.Endpoint implements it.
	Endpoint transport.Puncher
	// OpenControl returns an authenticated stream to the desktop dedicated
	// to the control channel, such as the mutual TLS connection over Tor that
	// tor.Client.DialControlTLS opens: it negotiates identity.ControlALPN, so
	// the onion listener of the desktop hands it to the control channel
	// instead of the edge.
	OpenControl func(ctx context.Context, desktop Desktop) (io.ReadWriteCloser, error)
	// Candidates returns the fresh phone candidates, such as the address STUN
	// reflects through Endpoint and the global IPv6 addresses. It runs while
	// the channel opens and must return once ctx ends.
	Candidates func(ctx context.Context) ([]pairing.Candidate, error)
	// Handler receives what the desktop sends while the channel is open, such
	// as a renewed reach card for Manager.UpdateCard.
	Handler rendezvous.Handler
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

var _ Puncher = (*RendezvousPuncher)(nil)

type gathered struct {
	list []pairing.Candidate
	err  error
}

// Punch returns the direct session the punch produced.
func (puncher *RendezvousPuncher) Punch(ctx context.Context, desktop Desktop) (transport.Session, error) {
	if puncher.Local == nil || puncher.Endpoint == nil || puncher.OpenControl == nil || puncher.Candidates == nil {
		return nil, errors.New("rendezvous puncher needs the identity, endpoint, control stream and candidates")
	}
	// STUN and the Tor round trips both take seconds, so the candidates are
	// gathered while the channel opens; Punch waits for the gathering to end.
	gatherCtx, stopGathering := context.WithCancel(ctx)
	results := make(chan gathered, 1)
	go func() {
		list, err := puncher.Candidates(gatherCtx)
		results <- gathered{list: list, err: err}
	}()
	pending := true
	defer func() {
		stopGathering()
		if pending {
			<-results
		}
	}()

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

	pending = false
	session, err := puncher.run(ctx, conn, results)
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

func (puncher *RendezvousPuncher) run(ctx context.Context, conn *rendezvous.Conn, results <-chan gathered) (transport.Session, error) {
	// The gathering honors ctx, so waiting for it never outlasts the budget.
	result := <-results
	if result.err != nil {
		return nil, fmt.Errorf("collect phone candidates: %w", result.err)
	}
	if _, err := conn.SendCandidates(ctx, result.list, 0); err != nil {
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
