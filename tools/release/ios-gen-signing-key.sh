#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="$repo_root/secrets/codemagic_cert_key.pem"
mkdir -p "$repo_root/secrets"

if [[ -f "$output" ]]; then
  echo "A chave já existe em $output" >&2
else
  ssh-keygen -t rsa -b 2048 -m PEM -f "$output" -q -N ""
  rm -f "$output.pub"
  chmod 600 "$output"
  echo "Chave RSA gerada em $output" >&2
fi

if ! git -C "$repo_root" check-ignore -q "$output"; then
  echo "A chave não está protegida pelo gitignore" >&2
  exit 1
fi

echo "CERTIFICATE_PRIVATE_KEY em base64" >&2
base64 < "$output" | tr -d '\n'
echo
