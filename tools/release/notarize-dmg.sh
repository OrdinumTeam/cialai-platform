#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Notariza e grampeia um DMG já assinado com Developer ID.
# O Tauri notariza o .app, mas o DMG criado depois sai só assinado, e o macOS
# avalia o próprio DMG baixado com quarentena antes de montar.
# Uso: tools/release/notarize-dmg.sh <arquivo.dmg>
# Ambiente: APPLE_API_KEY, APPLE_API_ISSUER e APPLE_API_KEY_PATH, o mesmo trio da
# notarização do Tauri. Nenhum valor é impresso.
set -euo pipefail

dmg="${1:-}"
[[ -f "$dmg" && "$dmg" == *.dmg ]] || { echo "Informe um arquivo .dmg existente" >&2; exit 64; }
: "${APPLE_API_KEY:?Defina APPLE_API_KEY}"
: "${APPLE_API_ISSUER:?Defina APPLE_API_ISSUER}"
: "${APPLE_API_KEY_PATH:?Defina APPLE_API_KEY_PATH}"
[[ -f "$APPLE_API_KEY_PATH" ]] || { echo "A chave da API da Apple não existe no caminho informado" >&2; exit 1; }

codesign --verify --strict "$dmg"

result="$(mktemp)"
trap 'rm -f "$result"' EXIT
xcrun notarytool submit "$dmg" \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
  --wait --timeout 60m --output-format json > "$result"
status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status", ""))' "$result")"
submission="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id", ""))' "$result")"
echo "Notarização do DMG: $status, envio $submission"
[[ "$status" == "Accepted" ]] || {
  xcrun notarytool log "$submission" \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" >&2 || true
  exit 1
}

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
