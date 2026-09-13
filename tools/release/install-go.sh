#!/usr/bin/env bash
# Instala uma versão exata do Go usando o checksum publicado em go.dev.
set -euo pipefail

go_version="${1:?Uso: install-go.sh <versao>}"
[[ "$go_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Versão do Go inválida" >&2
  return 64 2>/dev/null || exit 64
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tool_root="${CIALAI_TOOL_DIR:-${CM_BUILD_DIR:-$repo_root/.local}/tools}"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform="darwin-arm64" ;;
  Darwin:x86_64) platform="darwin-amd64" ;;
  *) echo "Plataforma sem pacote móvel do Go configurado" >&2; return 1 2>/dev/null || exit 1 ;;
esac
archive="go${go_version}.${platform}.tar.gz"
install_dir="$tool_root/go"

if [[ -x "$install_dir/bin/go" && "$($install_dir/bin/go env GOVERSION)" == "go$go_version" ]]; then
  export PATH="$install_dir/bin:$PATH"
  [[ -z "${CM_ENV:-}" ]] || printf 'PATH=%s\n' "$PATH" >> "$CM_ENV"
  return 0 2>/dev/null || exit 0
fi
[[ ! -e "$install_dir" ]] || {
  echo "Já existe outra instalação de Go em $install_dir" >&2
  return 1 2>/dev/null || exit 1
}

mkdir -p "$tool_root"
download_dir="$(mktemp -d /tmp/cialai-go.XXXXXX)"
trap 'rm -R "$download_dir"' RETURN
metadata="$download_dir/releases.json"
curl -fsSL 'https://go.dev/dl/?mode=json&include=all' -o "$metadata"
checksum="$(GO_METADATA="$metadata" GO_ARCHIVE="$archive" python3 -c '
import json, os
with open(os.environ["GO_METADATA"], encoding="utf-8") as source:
    releases = json.load(source)
for release in releases:
    for item in release.get("files", []):
        if item.get("filename") == os.environ["GO_ARCHIVE"]:
            print(item.get("sha256", ""))
            raise SystemExit
')"
[[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Checksum oficial não encontrado para $archive" >&2
  return 1 2>/dev/null || exit 1
}
curl -fsSL "https://go.dev/dl/$archive" -o "$download_dir/$archive"
printf '%s  %s\n' "$checksum" "$download_dir/$archive" | shasum -a 256 -c -
tar -C "$tool_root" -xzf "$download_dir/$archive"
test "$($install_dir/bin/go env GOVERSION)" = "go$go_version"
export PATH="$install_dir/bin:$PATH"
[[ -z "${CM_ENV:-}" ]] || printf 'PATH=%s\n' "$PATH" >> "$CM_ENV"
