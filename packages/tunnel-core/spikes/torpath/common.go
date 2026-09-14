// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"time"
)

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func durationMS(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}

func percentiles(samples []time.Duration) (median, p95 time.Duration) {
	if len(samples) == 0 {
		return 0, 0
	}
	ordered := slices.Clone(samples)
	slices.Sort(ordered)
	median = ordered[(len(ordered)-1)/2]
	p95 = ordered[((len(ordered)*95+99)/100)-1]
	return median, p95
}

func requirePositive(name string, value int) error {
	if value < 1 {
		return fmt.Errorf("%s must be positive", name)
	}
	return nil
}
