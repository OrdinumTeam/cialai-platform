#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CODEMAGIC_ENV_FILE="${CIALAI_RELEASE_ENV_FILE:-$REPO_ROOT/.env}"

cm_read_local_value() {
  local key="$1"
  [[ -f "$CODEMAGIC_ENV_FILE" ]] || return 0
  grep -E "^${key}=" "$CODEMAGIC_ENV_FILE" | head -1 | cut -d= -f2-
}

if [[ -z "${CODEMAGIC_API_TOKEN:-}" ]]; then
  CODEMAGIC_API_TOKEN="$(cm_read_local_value CODEMAGIC_API_TOKEN)"
fi
: "${CODEMAGIC_API_TOKEN:?Defina CODEMAGIC_API_TOKEN no ambiente ou no arquivo local configurado}"

if [[ -z "${CODEMAGIC_APP_ID:-}" ]]; then
  CODEMAGIC_APP_ID="$(cm_read_local_value CODEMAGIC_APP_ID)"
fi
: "${CODEMAGIC_APP_ID:?Defina CODEMAGIC_APP_ID no ambiente ou no arquivo local configurado}"

CODEMAGIC_WORKFLOW_ID="${CODEMAGIC_WORKFLOW_ID:-ios-testflight}"
CODEMAGIC_BRANCH="${CODEMAGIC_BRANCH:-main}"
CM_API="https://api.codemagic.io"

command -v curl >/dev/null || { echo "curl não encontrado" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 não encontrado" >&2; exit 1; }

cm_curl() {
  curl -fsS -H "x-auth-token: $CODEMAGIC_API_TOKEN" "$@"
}

cm_download() {
  local url="$1"
  local destination="$2"
  local headers
  local status
  local redirect
  local scope
  headers="$(mktemp /tmp/cialai-cm-headers.XXXXXX)"
  trap 'rm -f "$headers"' RETURN

  scope="$(CM_DOWNLOAD_URL="$url" python3 -c '
import os, sys
from urllib.parse import urlsplit
value = os.environ["CM_DOWNLOAD_URL"]
parsed = urlsplit(value)
if any(ord(char) < 32 for char in value) or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
    sys.exit(2)
print("api" if parsed.hostname == "api.codemagic.io" and parsed.port is None else "external")
')" || { echo "URL de artifact inválida" >&2; return 1; }

  if [[ "$scope" == "api" ]]; then
    status="$(curl -fsS -D "$headers" -o "$destination" -H "x-auth-token: $CODEMAGIC_API_TOKEN" -w '%{http_code}' "$url")"
  else
    status="$(curl -fsS -D "$headers" -o "$destination" -w '%{http_code}' "$url")"
  fi
  if [[ "$status" == 3* ]]; then
    redirect="$(awk 'tolower($1) == "location:" {sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$headers")"
    scope="$(CM_DOWNLOAD_URL="$redirect" python3 -c '
import os, sys
from urllib.parse import urlsplit
value = os.environ["CM_DOWNLOAD_URL"]
parsed = urlsplit(value)
if any(ord(char) < 32 for char in value) or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
    sys.exit(2)
print("api" if parsed.hostname == "api.codemagic.io" and parsed.port is None else "external")
')" || { echo "Redirecionamento de artifact inválido" >&2; return 1; }
    if [[ "$scope" == "api" ]]; then
      curl -fsS -H "x-auth-token: $CODEMAGIC_API_TOKEN" "$redirect" -o "$destination"
    else
      curl -fsS "$redirect" -o "$destination"
    fi
  elif [[ "$status" != 2* ]]; then
    echo "Falha HTTP ao baixar artifact" >&2
    return 1
  fi
}

cm_latest_build_id() {
  cm_curl "$CM_API/builds?appId=$CODEMAGIC_APP_ID" \
    | python3 -c 'import json,sys; builds=json.load(sys.stdin).get("builds", []); print(builds[0]["_id"] if builds else "")'
}
