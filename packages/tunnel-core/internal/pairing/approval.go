// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

// approvalDomain separates the approval code hash from any other use of the
// pairing id and the device key.
const approvalDomain = "cialai-approval-v1\x00"

// ApprovalCode derives the four digit code that the desktop shows when a
// pairing needs approval and that the phone shows before it asks to pair. Both
// sides compute it from the one-use pairing id of the QR and the Ed25519 key
// of the phone, so a second phone that photographed the QR gets a different
// code on the desktop than the one on the phone of the person pairing.
func ApprovalCode(pairID string, deviceKey ed25519.PublicKey) string {
	digest := sha256.New()
	digest.Write([]byte(approvalDomain))
	digest.Write([]byte(pairID))
	digest.Write([]byte{0})
	digest.Write(deviceKey)
	sum := digest.Sum(nil)
	return fmt.Sprintf("%04d", binary.BigEndian.Uint32(sum[:4])%10000)
}
