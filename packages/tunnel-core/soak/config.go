// SPDX-License-Identifier: Apache-2.0
// Package soak contains long-running robustness checks that are opt-in and
// stay outside the ordinary unit-test suite.
package soak

import (
	"fmt"
	"os"
	"time"
)

const (
	SocketCount = 8
	FrameBytes  = 1 << 20
	BurstBytes  = 50 << 20
)

var (
	DefaultDuration      = 24 * time.Hour
	DefaultBurstInterval = 10 * time.Second
)

type Config struct {
	Duration      time.Duration
	BurstInterval time.Duration
	ReportPath    string
}

func ConfigFromEnvironment() (Config, error) {
	duration, err := durationEnvironment("CIALAI_SOAK_DURATION", DefaultDuration)
	if err != nil {
		return Config{}, err
	}
	interval, err := durationEnvironment("CIALAI_SOAK_BURST_INTERVAL", DefaultBurstInterval)
	if err != nil {
		return Config{}, err
	}
	if duration <= 0 {
		return Config{}, fmt.Errorf("CIALAI_SOAK_DURATION must be positive")
	}
	if interval <= 0 || interval >= time.Minute {
		return Config{}, fmt.Errorf("CIALAI_SOAK_BURST_INTERVAL must be positive and shorter than one minute")
	}
	path := os.Getenv("CIALAI_SOAK_REPORT")
	if path == "" {
		// `go test ./soak` executes with the package directory as cwd.
		path = "../build/soak/proxy-soak.json"
	}
	return Config{Duration: duration, BurstInterval: interval, ReportPath: path}, nil
}

func durationEnvironment(name string, fallback time.Duration) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", name, err)
	}
	return value, nil
}
