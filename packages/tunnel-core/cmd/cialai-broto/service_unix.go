//go:build !windows

package main

import "context"

func runService(ctx context.Context, serve func(context.Context) error) error { return serve(ctx) }
