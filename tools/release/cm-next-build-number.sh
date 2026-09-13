#!/usr/bin/env bash
set -euo pipefail

: "${APP_STORE_APP_ID:?Configure APP_STORE_APP_ID no aplicativo do Codemagic}"
case "$APP_STORE_APP_ID" in
  *[!0-9]*|'') echo "APP_STORE_APP_ID deve conter somente dígitos" >&2; exit 1 ;;
esac

latest="$(app-store-connect get-latest-testflight-build-number "$APP_STORE_APP_ID")"
[[ -n "$latest" ]] || latest=0
case "$latest" in
  *[!0-9]*) echo "O App Store Connect não devolveu um número de build válido" >&2; exit 1 ;;
esac
printf '%s\n' "$((latest + 1))"
