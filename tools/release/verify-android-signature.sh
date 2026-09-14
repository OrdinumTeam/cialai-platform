#!/usr/bin/env bash
# Confere que o APK e o AAB foram assinados pela chave de upload, e não pela chave de depuração.
set -euo pipefail

usage() {
  echo "Uso: verify-android-signature.sh <keystore> <app.apk> <app.aab>" >&2
  exit 64
}

keystore="${1:-}"
apk="${2:-}"
aab="${3:-}"
[[ -n "$keystore" && -n "$apk" && -n "$aab" ]] || usage
: "${CM_KEYSTORE_PASSWORD:?Configure CM_KEYSTORE_PASSWORD no grupo android_credentials}"
: "${CM_KEY_ALIAS:?Configure CM_KEY_ALIAS no grupo android_credentials}"
for file in "$keystore" "$apk" "$aab"; do
  [[ -f "$file" ]] || { echo "Arquivo não encontrado: $file" >&2; exit 1; }
done

find_apksigner() {
  if [[ -n "${APKSIGNER:-}" ]]; then
    printf '%s\n' "$APKSIGNER"
    return
  fi
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  [[ -n "$sdk" && -d "$sdk/build-tools" ]] || return 0
  find "$sdk/build-tools" -mindepth 2 -maxdepth 2 -name apksigner -type f \
    | awk -F/ '{ split($(NF-1), v, "."); printf "%09d%09d%09d %s\n", v[1], v[2], v[3], $0 }' \
    | sort | tail -1 | cut -d' ' -f2-
}

# Impressão digital SHA-256 em hexadecimal minúsculo, sem separadores.
normalize() {
  tr -d ': \r\t' | tr '[:upper:]' '[:lower:]'
}

apksigner_bin="$(find_apksigner)"
[[ -n "$apksigner_bin" && -x "$apksigner_bin" ]] || { echo "apksigner não encontrado no Android SDK" >&2; exit 1; }

expected="$(keytool -list -v -keystore "$keystore" -alias "$CM_KEY_ALIAS" -storepass:env CM_KEYSTORE_PASSWORD \
  | awk '$1 == "SHA256:" { $1 = ""; print; exit }' | normalize)"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "Não foi possível ler a impressão digital da chave de upload" >&2; exit 1; }

apk_digest="$("$apksigner_bin" verify --print-certs "$apk" \
  | awk -F': ' '/^Signer #1 certificate SHA-256 digest:/ { print $2; exit }' | normalize)"
aab_digest="$(keytool -printcert -jarfile "$aab" \
  | awk '$1 == "SHA256:" { $1 = ""; print; exit }' | normalize)"

[[ "$apk_digest" == "$expected" ]] || { echo "O APK não foi assinado pela chave de upload" >&2; exit 1; }
[[ "$aab_digest" == "$expected" ]] || { echo "O AAB não foi assinado pela chave de upload" >&2; exit 1; }
echo "APK e AAB assinados pela chave de upload"
