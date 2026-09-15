// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"errors"
	"fmt"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// Error codes reported by the phone API when no path reaches the desktop.
const (
	CodeReserveUnavailable = "reserve_unavailable"
	CodeReservePreparing   = "reserve_preparing"
	CodeNoPath             = "no_path"
	CodeRevoked            = "revoked"
)

var (
	ErrReserveUnavailable = errors.New("no direct path and the Tor fallback is unavailable")
	ErrReservePreparing   = errors.New("no direct path and the Tor fallback is still bootstrapping")
	ErrNoPath             = errors.New("no path reaches the desktop")
	// ErrRevoked is the transport sentinel, so a revoked session error and a
	// manager error match the same value.
	ErrRevoked = transport.ErrRevoked
	ErrClosed  = errors.New("path manager closed")

	errNoTor              = errors.New("tor is not configured")
	errNetworkUnreachable = errors.New("network is unreachable")
	errReportedFailure    = errors.New("path failure reported")
	errMigrationless      = errors.New("session does not support migration")
)

var sentinels = map[string]error{
	CodeReserveUnavailable: ErrReserveUnavailable,
	CodeReservePreparing:   ErrReservePreparing,
	CodeNoPath:             ErrNoPath,
	CodeRevoked:            ErrRevoked,
}

// Error is a failure carrying the code of the phone API. errors.Is matches the
// sentinel of the code, such as ErrNoPath, and the cause.
type Error struct {
	Code  string
	Cause error
}

func newError(code string, cause error) *Error {
	return &Error{Code: code, Cause: cause}
}

func (problem *Error) Error() string {
	sentinel, known := sentinels[problem.Code]
	switch {
	case problem.Cause == nil && known:
		return sentinel.Error()
	case problem.Cause == nil:
		return problem.Code
	case known && errors.Is(problem.Cause, sentinel):
		return problem.Cause.Error()
	case known:
		return fmt.Sprintf("%v: %v", sentinel, problem.Cause)
	default:
		return fmt.Sprintf("%s: %v", problem.Code, problem.Cause)
	}
}

func (problem *Error) Unwrap() error { return problem.Cause }

func (problem *Error) Is(target error) bool {
	sentinel, ok := sentinels[problem.Code]
	return ok && target == sentinel
}

// Code returns the phone API code of err, or "" when it has none.
func Code(err error) string {
	var problem *Error
	if errors.As(err, &problem) {
		return problem.Code
	}
	if errors.Is(err, transport.ErrRevoked) {
		return CodeRevoked
	}
	return ""
}

func isRevoked(err error) bool {
	return err != nil && errors.Is(err, transport.ErrRevoked)
}
