// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"context"
	"errors"
	"fmt"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/quic-go/quic-go"
)

// QUIC application error codes carried by CONNECTION_CLOSE, so the phone can
// tell an expired pairing from a revoked key.
const (
	codeNormal            quic.ApplicationErrorCode = 0x000
	codePeerInvalid       quic.ApplicationErrorCode = 0x101
	codePairingInactive   quic.ApplicationErrorCode = 0x102
	codeRestrictedLimit   quic.ApplicationErrorCode = 0x103
	codeRestrictedExpired quic.ApplicationErrorCode = 0x104
	codeRevoked           quic.ApplicationErrorCode = 0x105
	codeClosing           quic.ApplicationErrorCode = 0x106
)

// QUIC stream error codes carried by RESET_STREAM and STOP_SENDING.
const (
	streamCodeClosed  quic.StreamErrorCode = 0x000
	streamCodeRefused quic.StreamErrorCode = 0x110
)

var applicationErrors = map[quic.ApplicationErrorCode]error{
	codePeerInvalid:       transport.ErrPeerInvalid,
	codePairingInactive:   transport.ErrPairingInactive,
	codeRestrictedLimit:   transport.ErrRestrictedLimit,
	codeRestrictedExpired: transport.ErrRestrictedExpired,
	codeRevoked:           transport.ErrRevoked,
	codeClosing:           transport.ErrClosed,
}

// mapError wraps known QUIC codes with the transport sentinel errors and
// returns every other error unchanged, so io.EOF and net.Error timeouts keep
// their identity for callers such as net/http.
func mapError(err error) error {
	if err == nil {
		return nil
	}
	var application *quic.ApplicationError
	if errors.As(err, &application) {
		if sentinel, ok := applicationErrors[application.ErrorCode]; ok {
			return fmt.Errorf("%w: %w", sentinel, err)
		}
		return err
	}
	var streamError *quic.StreamError
	if errors.As(err, &streamError) && streamError.ErrorCode == streamCodeRefused {
		return fmt.Errorf("%w: %w", transport.ErrStreamRefused, err)
	}
	return err
}

func sessionError(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return mapError(cause)
	}
	return transport.ErrClosed
}
