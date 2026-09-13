#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image=${CIALAI_LINUX_DESKTOP_IMAGE:-cialai-linux-desktop:ubuntu-22.04-$$}
if test -z "${CIALAI_LINUX_DESKTOP_IMAGE:-}"; then
  trap 'docker image rm "$image" >/dev/null 2>&1 || true' 0
fi

require_disk() {
  available_kib=$(df -Pk "$root" | awk 'NR == 2 { print $4 }')
  if test "$available_kib" -lt 5242880; then
    echo "Espaço livre abaixo de 5 GiB; validação Linux não iniciada" >&2
    exit 2
  fi
}

require_disk
docker build --memory 6g --file "$root/tools/docker/linux-desktop.Dockerfile" --tag "$image" "$root"
require_disk
docker run --rm --memory 6g \
  --env CARGO_BUILD_JOBS=2 \
  --env CARGO_TARGET_DIR=/root/.cache/cialai-target-d \
  --volume "$root:/workspace:ro" \
  "$image" \
  /bin/bash -lc '
    set -euo pipefail
    cargo test --manifest-path /workspace/apps/desktop/src-tauri/Cargo.toml --locked --lib workspace::browser -j 2
    PATH=/usr/local/bin:/usr/bin:/bin /root/.cargo/bin/cargo test \
      --manifest-path /workspace/apps/desktop/src-tauri/Cargo.toml \
      --locked --lib installs_the_real_playwright_chromium -j 2 \
      -- --ignored --nocapture
  '
