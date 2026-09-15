#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Confere que nenhuma dependência do Mesa do sistema vai embutida no AppImage. Uma cópia antiga no bundle
# é carregada no lugar da do sistema quando o WebKit abre o libEGL_mesa e o libgallium, e o EGL não
# inicializa: EGL_BAD_ALLOC ou EGL_BAD_PARAMETER seguido de Aborting.
#
# Uso: tools/release/appimage/mesa-conflicts.sh <AppImage>
set -euo pipefail

appimage="$(readlink -f "${1:?informe o AppImage}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod +x "$appimage"
(cd "$work" && env -u LD_LIBRARY_PATH "$appimage" --appimage-extract >/dev/null)
libraries="$work/squashfs-root/usr/lib"

shopt -s nullglob
mesa=()
for dir in /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu; do
  for file in "$dir"/libEGL_mesa.so.0 "$dir"/libGLX_mesa.so.0 "$dir"/libgbm.so.1 "$dir"/libgallium-*.so \
    "$dir"/dri/*_dri.so "$dir"/gbm/*.so "$dir"/libvulkan_*.so; do
    [ -e "$file" ] && mesa+=("$file")
  done
done
if (( ${#mesa[@]} == 0 )); then
  echo "FAIL: Mesa não encontrado no sistema"
  exit 1
fi

conflicts=0
checked=0
while read -r name; do
  checked=$((checked + 1))
  found="$(find "$libraries" -path "$libraries/Cialai" -prune -o -name "$name" -print -quit)"
  if [ -n "$found" ]; then
    echo "CONFLITO: $name em ${found#"$work"/squashfs-root/}"
    conflicts=$((conflicts + 1))
  fi
done < <(env -u LD_LIBRARY_PATH ldd "${mesa[@]}" 2>/dev/null | awk '/=>/ { print $1 }' | sort -u)

if (( conflicts )); then
  echo "FAIL: $conflicts das $checked dependências de ${#mesa[@]} arquivos do Mesa estão no bundle"
  exit 1
fi
echo "PASS Mesa: nenhuma das $checked dependências de ${#mesa[@]} arquivos do Mesa está no bundle"
