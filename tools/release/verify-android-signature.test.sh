#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d /tmp/cialai-android-signature-test.XXXXXX)"
trap 'rm -R "$test_dir"' EXIT

upload="AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
upload_hex="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
debug_hex="1111111111111111111111111111111111111111111111111111111111111111"

mkdir -p "$test_dir/sdk/build-tools/9.0.0" "$test_dir/sdk/build-tools/36.0.0" "$test_dir/bin"
cat > "$test_dir/bin/keytool" <<STUB
#!/usr/bin/env bash
[[ "\$*" == *"-storepass:env CM_KEYSTORE_PASSWORD"* || "\$1" == "-printcert" ]] || exit 9
if [[ "\$1" == "-printcert" ]]; then
  printf 'Signer #1:\n\nCertificate fingerprints:\n\t SHA1: 00\n\t SHA256: %s\n' "\${CM_TEST_AAB_DIGEST:-$upload}"
else
  printf 'Alias name: upload\nCertificate fingerprints:\n\t SHA1: 00\n\t SHA256: $upload\n'
fi
STUB
for version in 9.0.0 36.0.0; do
  cat > "$test_dir/sdk/build-tools/$version/apksigner" <<STUB
#!/usr/bin/env bash
[[ "$version" == "36.0.0" ]] || exit 7
printf 'Signer #1 certificate DN: CN=Cialai\nSigner #1 certificate SHA-256 digest: %s\n' "\${CM_TEST_APK_DIGEST:-$upload_hex}"
STUB
  chmod +x "$test_dir/sdk/build-tools/$version/apksigner"
done
chmod +x "$test_dir/bin/keytool"
: > "$test_dir/upload.jks"
: > "$test_dir/app.apk"
: > "$test_dir/app.aab"

run() {
  PATH="$test_dir/bin:$PATH" ANDROID_HOME="$test_dir/sdk" CM_KEYSTORE_PASSWORD=fixture CM_KEY_ALIAS=upload \
    "$@" bash "$repo_root/tools/release/verify-android-signature.sh" \
    "$test_dir/upload.jks" "$test_dir/app.apk" "$test_dir/app.aab"
}

run env >/dev/null
if run env CM_TEST_APK_DIGEST="$debug_hex" >/dev/null 2>&1; then
  echo "APK com a chave de depuração foi aceito" >&2
  exit 1
fi
if run env CM_TEST_AAB_DIGEST="$debug_hex" >/dev/null 2>&1; then
  echo "AAB com a chave de depuração foi aceito" >&2
  exit 1
fi
if PATH="$test_dir/bin:$PATH" ANDROID_HOME="$test_dir/missing" CM_KEYSTORE_PASSWORD=fixture CM_KEY_ALIAS=upload \
  bash "$repo_root/tools/release/verify-android-signature.sh" \
  "$test_dir/upload.jks" "$test_dir/app.apk" "$test_dir/app.aab" >/dev/null 2>&1; then
  echo "Ausência do apksigner foi aceita" >&2
  exit 1
fi
if bash "$repo_root/tools/release/verify-android-signature.sh" >/dev/null 2>&1; then
  echo "Chamada sem argumentos foi aceita" >&2
  exit 1
fi
echo "verify-android-signature: 5 casos passaram"
