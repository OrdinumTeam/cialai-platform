#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture="$root/tools/fixtures/office/cialai-preview.rtf"

verify_pdf() {
  pdf=$1
  test -s "$pdf"
  signature=$(dd if="$pdf" bs=4 count=1 2>/dev/null)
  test "$signature" = "%PDF"
  wc -c < "$pdf"
}

case ${1:-$(uname -s)} in
  macos|Darwin)
    soffice=${SOFFICE:-}
    if test -z "$soffice"; then
      soffice=$(command -v soffice || true)
    fi
    if test -z "$soffice" || ! test -x "$soffice"; then
      echo "LibreOffice não encontrado no macOS" >&2
      exit 2
    fi
    work=$(mktemp -d "${TMPDIR:-/tmp}/cialai-office.XXXXXX")
    trap 'rm -rf "$work"' EXIT HUP INT TERM
    "$soffice" --headless --nologo --norestore --nolockcheck \
      --convert-to pdf --outdir "$work" "$fixture" >/dev/null
    bytes=$(verify_pdf "$work/cialai-preview.pdf")
    echo "PASS LibreOffice macOS: PDF real com $bytes bytes"
    ;;
  linux|Linux)
    available_kib=$(df -Pk "$root" | awk 'NR == 2 { print $4 }')
    if test "$available_kib" -lt 5242880; then
      echo "Espaço livre abaixo de 5 GiB; validação Linux não iniciada" >&2
      exit 2
    fi
    docker run --rm --memory 6g \
      --volume "$fixture:/fixture/cialai-preview.rtf:ro" \
      ubuntu:22.04 \
      /bin/bash -lc '
        set -euo pipefail
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends libreoffice-writer >/dev/null
        mkdir /output
        soffice --headless --nologo --norestore --nolockcheck \
          --convert-to pdf --outdir /output /fixture/cialai-preview.rtf >/dev/null
        test -s /output/cialai-preview.pdf
        test "$(dd if=/output/cialai-preview.pdf bs=4 count=1 2>/dev/null)" = "%PDF"
        echo "PASS LibreOffice Ubuntu 22.04: PDF real com $(wc -c < /output/cialai-preview.pdf) bytes"
      '
    ;;
  *)
    echo "Uso: $0 macos ou linux" >&2
    exit 2
    ;;
esac
