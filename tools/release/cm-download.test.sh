#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d /tmp/cialai-download-test.XXXXXX)"
trap 'rm -R "$test_dir"' EXIT
calls="$test_dir/calls"

cat > "$test_dir/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "CALL ${CM_TEST_CASE:?} $*" >> "${CM_TEST_CALLS:?}"
destination=""
headers=""
wants_status=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) destination="$2"; shift 2 ;;
    -D) headers="$2"; shift 2 ;;
    -w) wants_status=true; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$CM_TEST_CASE" == redirect-api && ! -e "$CM_TEST_CALLS.redirected" ]]; then
  printf 'HTTP/1.1 302 Found\r\nLocation: https://storage.example/artifact.zip\r\n\r\n' > "$headers"
  : > "$CM_TEST_CALLS.redirected"
  $wants_status && printf '302'
else
  [[ -z "$destination" ]] || printf 'artifact' > "$destination"
  $wants_status && printf '200'
fi
exit 0
STUB
chmod +x "$test_dir/curl"

export PATH="$test_dir:$PATH"
export CODEMAGIC_API_TOKEN="fixture-token"
export CODEMAGIC_APP_ID="fixture-app"
export CM_TEST_CALLS="$calls"
source "$repo_root/tools/release/_lib.sh"

CM_TEST_CASE=external cm_download 'https://storage.example/artifact.zip' "$test_dir/external.zip"
external_call="$(tail -1 "$calls")"
[[ "$external_call" != *x-auth-token* ]] || { echo "Token enviado ao storage externo" >&2; exit 1; }

CM_TEST_CASE=api cm_download 'https://api.codemagic.io/artifacts/secure' "$test_dir/api.zip"
api_call="$(tail -1 "$calls")"
[[ "$api_call" == *x-auth-token* ]] || { echo "Token ausente na API do Codemagic" >&2; exit 1; }

CM_TEST_CASE=redirect-api cm_download 'https://api.codemagic.io/artifacts/redirect' "$test_dir/redirect.zip"
redirect_call="$(tail -1 "$calls")"
[[ "$redirect_call" != *x-auth-token* ]] || { echo "Token enviado após redirect externo" >&2; exit 1; }

if CM_TEST_CASE=unsafe cm_download 'http://api.codemagic.io/artifact' "$test_dir/unsafe" 2>/dev/null; then
  echo "URL sem HTTPS foi aceita" >&2
  exit 1
fi

echo "Escopo do token de download validado"
