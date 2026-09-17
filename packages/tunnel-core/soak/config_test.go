// SPDX-License-Identifier: Apache-2.0
package soak

import (
	"testing"
	"time"
)

func TestConfigFromEnvironment(t *testing.T) {
	t.Setenv("CIALAI_SOAK_DURATION", "30m")
	t.Setenv("CIALAI_SOAK_BURST_INTERVAL", "5s")
	t.Setenv("CIALAI_SOAK_PATH_INTERVAL", "7s")
	t.Setenv("CIALAI_SOAK_REPORT", "/tmp/cialai-soak.json")
	config, err := ConfigFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if config.Duration != 30*time.Minute || config.BurstInterval != 5*time.Second || config.PathInterval != 7*time.Second || config.ReportPath != "/tmp/cialai-soak.json" {
		t.Fatalf("unexpected config: %#v", config)
	}
}

func TestConfigRejectsUnsafeIntervals(t *testing.T) {
	for _, name := range []string{"CIALAI_SOAK_BURST_INTERVAL", "CIALAI_SOAK_PATH_INTERVAL"} {
		for _, interval := range []string{"0s", "60s", "invalid"} {
			t.Run(name+"="+interval, func(t *testing.T) {
				t.Setenv(name, interval)
				if _, err := ConfigFromEnvironment(); err == nil {
					t.Fatalf("accepted %s %q", name, interval)
				}
			})
		}
	}
}
