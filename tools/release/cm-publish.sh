#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_id="$("$script_dir/cm-trigger.sh" "$@")"
printf 'Build disparado: %s\n' "$build_id"
if ! "$script_dir/cm-watch.sh" "$build_id"; then
  "$script_dir/cm-log.sh" "$build_id" --download || true
  exit 1
fi
"$script_dir/cm-log.sh" "$build_id"
