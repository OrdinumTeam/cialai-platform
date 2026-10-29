#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
: "${APPLE_CERTIFICATE:?}" "${APPLE_CERTIFICATE_PASSWORD:?}" "${APPLE_SIGNING_IDENTITY:?}" "${APPLE_ID:?}" "${APPLE_PASSWORD:?}" "${APPLE_TEAM_ID:?}"
payload=$1
keychain="$RUNNER_TEMP/broto-signing.keychain-db"
certificate="$RUNNER_TEMP/broto.p12"
password=$(openssl rand -base64 32)
trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true; rm -f "$certificate"' EXIT
umask 077
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate"
security create-keychain -p "$password" "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$certificate" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
find "$payload" -type f -print0 | while IFS= read -r -d '' file; do
  if file "$file" | grep -q 'Mach-O'; then
    codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" "$file"
    codesign --verify --strict "$file"
  fi
done
find "$payload" -type d -name '*.app' -print0 | while IFS= read -r -d '' app; do
  codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
done
ditto -c -k --keepParent "$payload" "$RUNNER_TEMP/broto-notary.zip"
xcrun notarytool submit "$RUNNER_TEMP/broto-notary.zip" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
node --input-type=module - "$payload/tor" <<'JS'
import {writeResourceChecksums} from './tools/fetch-tor.mjs';
writeResourceChecksums(process.argv[2]);
JS
