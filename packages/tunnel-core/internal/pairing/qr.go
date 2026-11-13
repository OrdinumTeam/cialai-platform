// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

// The CIALAIQ1 QR is shown by a Broto that is not paired yet and scanned by a
// phone already paired with the host. It carries the Broto key and a one-use
// secret. The host and the Broto derive from that secret the temporary onion
// service, the pairing session and the LAN marker, so the Broto finds the
// host without knowing its address and the host accepts only the TLS key of
// the QR.
const (
	QRPrefix  = "CIALAIQ1."
	QRVersion = 1
	// MaxQRJSONBytes caps the JSON inside the QR text.
	MaxQRJSONBytes = 600
	// QRTTL is how long a Broto shows one QR.
	QRTTL = 10 * time.Minute
	// QRGrace keeps the host session alive after the expiry in the QR, for
	// clocks that disagree; it also bounds how late a QR may be scanned.
	QRGrace      = 2 * time.Minute
	QRSecretSize = 32
	QRNonceSize  = 32
	// MaxLiveQRSessions bounds the QR sessions a host runs at once.
	MaxLiveQRSessions = 2
)

const (
	qrPairIDPrefix = "q_"
	qrPairIDBytes  = 16
	qrSalt         = "cialai-broto-qr/v1"
	qrDigitsDomain = "cialai-broto-qr/sas/v1\x00"
)

// QR is the decoded CIALAIQ1 payload.
type QR struct {
	Version   int    `json:"v"`
	Key       string `json:"k"`
	Secret    string `json:"s"`
	ExpiresAt int64  `json:"e"`
	Name      string `json:"n"`
	Platform  string `json:"p"`
}

// QRKeys are the values both sides derive from the QR secret.
type QRKeys struct {
	// OnionSeed is the Ed25519 seed of the temporary onion service.
	OnionSeed [32]byte
	// PairID and PairSecret address and authenticate the session in
	// POST /pair; PairSecret is already base64url.
	PairID     string
	PairSecret string
	// MarkerSeed is the Ed25519 seed of the key announced by mDNS.
	MarkerSeed [32]byte
}

// MarkerKey is the public key the host announces on the LAN for this QR.
func (keys QRKeys) MarkerKey() ed25519.PublicKey {
	return ed25519.NewKeyFromSeed(keys.MarkerSeed[:]).Public().(ed25519.PublicKey)
}

// NewQR creates the QR of a Broto with a fresh secret.
func NewQR(key ed25519.PublicKey, name, platform string, expiresAt time.Time, random io.Reader) (QR, error) {
	if random == nil {
		random = rand.Reader
	}
	secret := make([]byte, QRSecretSize)
	if _, err := io.ReadFull(random, secret); err != nil {
		return QR{}, wrapError("qr_invalid", "Não foi possível criar o código do Broto.", err)
	}
	qr := QR{
		Version: QRVersion, Key: identity.EncodePublicKey(key), Secret: base64.RawURLEncoding.EncodeToString(secret),
		ExpiresAt: expiresAt.Unix(), Name: name, Platform: platform,
	}
	if err := validateQR(qr); err != nil {
		return QR{}, err
	}
	return qr, nil
}

func EncodeQR(qr QR) (string, error) {
	if err := validateQR(qr); err != nil {
		return "", err
	}
	raw, err := json.Marshal(qr)
	if err != nil || len(raw) > MaxQRJSONBytes {
		return "", NewError("qr_invalid", "O código do Broto excede o tamanho permitido.")
	}
	return QRPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

// DecodeQR is as strict as Decode: no unknown fields, no trailing data and
// only the canonical encoding the Broto emits.
func DecodeQR(text string) (QR, error) {
	encoded, ok := strings.CutPrefix(text, QRPrefix)
	if !ok {
		return QR{}, NewError("qr_invalid", "Este QR code não é um código de Broto do Cialai.")
	}
	if encoded == "" || len(encoded) > base64.RawURLEncoding.EncodedLen(MaxQRJSONBytes) {
		return QR{}, NewError("qr_invalid", "O código do Broto tem tamanho inválido.")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) > MaxQRJSONBytes {
		return QR{}, NewError("qr_invalid", "O código do Broto está corrompido.")
	}
	var qr QR
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&qr); err != nil {
		return QR{}, wrapError("qr_invalid", "O código do Broto tem campos inválidos.", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return QR{}, NewError("qr_invalid", "O código do Broto contém dados adicionais.")
	}
	if err := validateQR(qr); err != nil {
		return QR{}, err
	}
	if canonical, err := json.Marshal(qr); err != nil || !bytes.Equal(canonical, raw) {
		return QR{}, NewError("qr_invalid", "O código do Broto tem campos inválidos.")
	}
	return qr, nil
}

func validateQR(qr QR) error {
	if qr.Version != QRVersion {
		return NewError("qr_invalid", "Atualize o Cialai para ler este código do Broto.")
	}
	if _, err := identity.ParsePublicKey(qr.Key); err != nil || !validRawURLBytes(qr.Secret, QRSecretSize) || qr.ExpiresAt <= 0 {
		return NewError("qr_invalid", "O código do Broto é inválido.")
	}
	if strings.TrimSpace(qr.Name) == "" || !validName(qr.Name, 48) || !regexpToken(qr.Platform, 16) {
		return NewError("qr_invalid", "O nome ou a plataforma do Broto no código é inválido.")
	}
	return nil
}

// SecretBytes returns the decoded secret of a valid QR.
func (qr QR) SecretBytes() ([]byte, error) {
	secret, err := base64.RawURLEncoding.DecodeString(qr.Secret)
	if err != nil || len(secret) != QRSecretSize {
		return nil, NewError("qr_invalid", "O código do Broto é inválido.")
	}
	return secret, nil
}

// Derive returns the keys of a valid QR.
func (qr QR) Derive() (QRKeys, error) {
	secret, err := qr.SecretBytes()
	if err != nil {
		return QRKeys{}, err
	}
	return DeriveQR(secret)
}

// DeriveQR expands the QR secret with HKDF-SHA-256, one info label per value,
// so no derived value reveals another or the secret.
func DeriveQR(secret []byte) (QRKeys, error) {
	if len(secret) != QRSecretSize {
		return QRKeys{}, NewError("qr_invalid", "O código do Broto é inválido.")
	}
	derive := func(label string, size int) ([]byte, error) {
		return hkdf.Key(sha256.New, secret, []byte(qrSalt), label, size)
	}
	var keys QRKeys
	onion, err := derive("onion", len(keys.OnionSeed))
	if err != nil {
		return QRKeys{}, wrapError("qr_invalid", "O código do Broto é inválido.", err)
	}
	pairID, err := derive("pair-id", qrPairIDBytes)
	if err != nil {
		return QRKeys{}, wrapError("qr_invalid", "O código do Broto é inválido.", err)
	}
	pairSecret, err := derive("pair-secret", QRSecretSize)
	if err != nil {
		return QRKeys{}, wrapError("qr_invalid", "O código do Broto é inválido.", err)
	}
	marker, err := derive("mdns", len(keys.MarkerSeed))
	if err != nil {
		return QRKeys{}, wrapError("qr_invalid", "O código do Broto é inválido.", err)
	}
	copy(keys.OnionSeed[:], onion)
	copy(keys.MarkerSeed[:], marker)
	keys.PairID = qrPairIDPrefix + base64.RawURLEncoding.EncodeToString(pairID)
	keys.PairSecret = base64.RawURLEncoding.EncodeToString(pairSecret)
	clear(onion)
	clear(pairSecret)
	clear(marker)
	return keys, nil
}

// QRDigits is the four digit check both sides show: the host on the phone and
// the Broto as the value the person types. It binds the host key the Broto
// recorded over TLS, the Broto key, the QR secret and the Broto nonce of the
// claim, so a host impersonated by someone who photographed the QR shows
// other digits than the real one.
func QRDigits(hostKey, brotoKey ed25519.PublicKey, secret, nonce []byte) string {
	digest := sha256.New()
	digest.Write([]byte(qrDigitsDomain))
	digest.Write(hostKey)
	digest.Write(brotoKey)
	digest.Write(secret)
	digest.Write(nonce)
	sum := digest.Sum(nil)
	return fmt.Sprintf("%04d", binary.BigEndian.Uint32(sum[:4])%10000)
}
