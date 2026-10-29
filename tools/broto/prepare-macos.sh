# SPDX-License-Identifier: Apache-2.0
# Source in the UI build shell so Tauri can discover the Developer ID identity.
set -euo pipefail
: "${APPLE_CERTIFICATE:?}" "${APPLE_CERTIFICATE_PASSWORD:?}" "${APPLE_SIGNING_IDENTITY:?}"
broto_ui_keychain="$RUNNER_TEMP/broto-ui-signing.keychain-db"
broto_ui_certificate="$RUNNER_TEMP/broto-ui.p12"
broto_ui_password=$(openssl rand -base64 32)
trap 'security delete-keychain "$broto_ui_keychain" >/dev/null 2>&1 || true; rm -f "$broto_ui_certificate"' EXIT
umask 077
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$broto_ui_certificate"
security create-keychain -p "$broto_ui_password" "$broto_ui_keychain"
security set-keychain-settings -lut 3600 "$broto_ui_keychain"
security unlock-keychain -p "$broto_ui_password" "$broto_ui_keychain"
security import "$broto_ui_certificate" -k "$broto_ui_keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$broto_ui_password" "$broto_ui_keychain" >/dev/null
security list-keychains -d user -s "$broto_ui_keychain" $(security list-keychains -d user | tr -d '"')
