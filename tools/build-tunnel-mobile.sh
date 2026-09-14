#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  echo "Uso: tools/build-tunnel-mobile.sh ios|android|all [diretorio de saida]" >&2
  exit 64
}

target="${1:-}"
case "$target" in
  ios|android|all) ;;
  *) usage ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_dir="$repo_root/packages/tunnel-core"
output_dir="${2:-$core_dir/build/mobile}"
tool_dir="$core_dir/build/mobile-tools"
[[ "$output_dir" != "/" && "$output_dir" != "$repo_root" && "$output_dir" != "$core_dir" ]] || {
  echo "Preflight falhou: escolha um diretorio de saida dedicado." >&2
  exit 1
}
mkdir -p "$output_dir" "$tool_dir"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Preflight falhou: comando $1 nao encontrado." >&2
    exit 1
  }
}

require_command go
require_command shasum

# Consulta dentro do módulo para que GOTOOLCHAIN=auto selecione a versão do
# go.mod mesmo quando o script é iniciado na raiz, cujo Go global pode ser mais antigo.
go_version="$(go -C "$core_dir" env GOVERSION)"
[[ "$go_version" == "go1.26.5" ]] || {
  echo "Preflight falhou: Go 1.26.5 e obrigatorio, encontrado $go_version." >&2
  exit 1
}

if [[ "$target" == "ios" || "$target" == "all" ]]; then
  [[ "$(uname -s)" == "Darwin" ]] || {
    echo "Preflight falhou: o artefato iOS exige um runner macOS." >&2
    exit 1
  }
  require_command xcodebuild
  require_command xcrun
  xcodebuild -version >/dev/null
  xcrun --sdk iphoneos --show-sdk-path >/dev/null
  xcrun --sdk iphonesimulator --show-sdk-path >/dev/null
fi

if [[ "$target" == "android" || "$target" == "all" ]]; then
  android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  [[ -n "$android_sdk" && -d "$android_sdk" ]] || {
    echo "Preflight falhou: defina ANDROID_HOME ou ANDROID_SDK_ROOT para um SDK Android instalado." >&2
    exit 1
  }
  ndk_root="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  if [[ -z "$ndk_root" && -d "$android_sdk/ndk" ]]; then
    ndk_root="$(find "$android_sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
  fi
  # O NDK publica binarios universais em darwin-x86_64 inclusive no Apple Silicon, e o gomobile procura esse nome.
  case "$(uname -s)" in
    Darwin) ndk_host="darwin-x86_64" ;;
    Linux) ndk_host="linux-x86_64" ;;
    *) ndk_host="" ;;
  esac
  [[ -n "$ndk_root" && -n "$ndk_host" && -x "$ndk_root/toolchains/llvm/prebuilt/$ndk_host/bin/clang" ]] || {
    echo "Preflight falhou: NDK Android com toolchain LLVM nao encontrado." >&2
    exit 1
  }
  export ANDROID_HOME="$android_sdk"
  export ANDROID_NDK_HOME="$ndk_root"
fi

cd "$core_dir"
go build -mod=readonly -o "$tool_dir/gobind" golang.org/x/mobile/cmd/gobind
PATH="$tool_dir:$PATH" go tool gomobile init

build_ios() {
  rm -rf "$output_dir/Tunnelcore.xcframework"
  PATH="$tool_dir:$PATH" go tool gomobile bind \
    -target=ios,iossimulator \
    -o "$output_dir/Tunnelcore.xcframework" \
    ./mobile
  ditto -c -k --sequesterRsrc --keepParent \
    "$output_dir/Tunnelcore.xcframework" \
    "$output_dir/Tunnelcore.xcframework.zip"
  # O hash leva só o nome do arquivo, para conferir em qualquer pasta e publicar sem caminho do runner.
  (cd "$output_dir" && shasum -a 256 Tunnelcore.xcframework.zip > Tunnelcore.xcframework.zip.sha256)
}

build_android() {
  PATH="$tool_dir:$PATH" go tool gomobile bind \
    -target=android/arm64,android/amd64 \
    -androidapi=26 \
    -o "$output_dir/tunnelcore.aar" \
    ./mobile
  (cd "$output_dir" && shasum -a 256 tunnelcore.aar > tunnelcore.aar.sha256)
}

case "$target" in
  ios) build_ios ;;
  android) build_android ;;
  all) build_ios; build_android ;;
esac

echo "Artefatos preparados em $output_dir. O aceite em aparelho continua pendente."
