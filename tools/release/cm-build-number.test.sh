#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d /tmp/cialai-build-number-test.XXXXXX)"
trap 'rm -R "$test_dir"' EXIT

cat > "$test_dir/app-store-connect" <<'STUB'
#!/usr/bin/env bash
case "${CM_TEST_MODE:?}" in
  first) exit 0 ;;
  published) printf '41\n' ;;
  auth_error) exit 23 ;;
  non_numeric) printf 'not-a-number\n' ;;
esac
STUB
chmod +x "$test_dir/app-store-connect"

actual="$(PATH="$test_dir:$PATH" CM_TEST_MODE=first APP_STORE_APP_ID=123 \
  "$repo_root/tools/release/cm-next-build-number.sh")"
test "$actual" = "1"
actual="$(PATH="$test_dir:$PATH" CM_TEST_MODE=published APP_STORE_APP_ID=123 \
  "$repo_root/tools/release/cm-next-build-number.sh")"
test "$actual" = "42"
if PATH="$test_dir:$PATH" CM_TEST_MODE=auth_error APP_STORE_APP_ID=123 \
  "$repo_root/tools/release/cm-next-build-number.sh" >/dev/null 2>&1; then
  echo "Falha de autenticação foi tratada como primeiro build" >&2
  exit 1
fi
if PATH="$test_dir:$PATH" CM_TEST_MODE=non_numeric APP_STORE_APP_ID=123 \
  "$repo_root/tools/release/cm-next-build-number.sh" >/dev/null 2>&1; then
  echo "Número inválido foi aceito" >&2
  exit 1
fi

echo "Casos de número do TestFlight validados"
