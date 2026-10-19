// SPDX-License-Identifier: Apache-2.0
//go:build !darwin && !linux && !windows

package statedir

import "errors"

func inspectProcess(int) (processIdentity, error) {
	// OS locks still work on BSD; migrating a live legacy owner requires an
	// identity reader before those platforms can safely support that upgrade.
	return processIdentity{}, errors.New("legacy process identity is unavailable on this platform")
}
