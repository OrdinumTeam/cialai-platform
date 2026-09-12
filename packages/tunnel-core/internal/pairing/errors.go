// SPDX-License-Identifier: Apache-2.0
package pairing

import "errors"

var ErrPairing = errors.New("pairing error")

type Error struct {
	code    string
	message string
	cause   error
}

func NewError(code, message string) error {
	return &Error{code: code, message: message}
}

func wrapError(code, message string, cause error) error {
	return &Error{code: code, message: message, cause: cause}
}

func (problem *Error) Error() string { return problem.message }

func (problem *Error) Unwrap() error { return problem.cause }

func (problem *Error) Is(target error) bool {
	return target == ErrPairing || errors.Is(problem.cause, target)
}

func Code(err error) string {
	var problem *Error
	if errors.As(err, &problem) {
		return problem.code
	}
	return ""
}
