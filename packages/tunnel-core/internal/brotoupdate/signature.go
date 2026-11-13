// SPDX-License-Identifier: Apache-2.0
package brotoupdate

import (
	"aead.dev/minisign"
	"context"
	"errors"
	"io"
	"os"
)

// VerifySignature verifies minisign in-process, including its authenticated comment.
func VerifySignature(ctx context.Context, file, signature, key string) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	var public minisign.PublicKey
	if e := public.UnmarshalText([]byte(key)); e != nil {
		return errors.New("invalid Broto public key")
	}
	sf, e := os.Open(signature)
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(sf, 16385))
	sf.Close()
	if e != nil {
		return e
	}
	if len(raw) > 16384 {
		return errors.New("Broto signature too large")
	}
	f, e := os.Open(file)
	if e != nil {
		return e
	}
	defer f.Close()
	reader := minisign.NewReader(f)
	if _, e = io.Copy(io.Discard, reader); e != nil {
		return e
	}
	if !reader.Verify(public, raw) {
		return errors.New("Broto update signature verification failed")
	}
	return ctx.Err()
}
