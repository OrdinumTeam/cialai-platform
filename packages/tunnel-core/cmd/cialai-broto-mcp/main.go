// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotohostipc"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotomcp"
	"os"
	"os/signal"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	path, e := brotohostipc.DefaultPath()
	if e == nil {
		e = brotomcp.Serve(ctx, os.Stdin, os.Stdout, func(ctx context.Context, method string, args json.RawMessage) (json.RawMessage, error) {
			return brotohostipc.Call(ctx, path, method, args)
		})
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, "Broto MCP:", e)
		os.Exit(1)
	}
}
