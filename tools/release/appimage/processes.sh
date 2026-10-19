#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Process selection is scoped to an isolated smoke fixture, never a name alone.
smoke_environ_of() {
  { tr '\0' '\n' <"${SMOKE_PROC_ROOT:-/proc}/$1/environ"; } 2>/dev/null || true
}

smoke_fixture_pids() {
  local fixture_home="$1" entry pid
  for entry in "${SMOKE_PROC_ROOT:-/proc}"/[0-9]*; do
    pid="${entry##*/}"
    if smoke_is_fixture "$pid" "$fixture_home"; then printf '%s\n' "$pid"; fi
  done
}

smoke_find_process() {
  local pattern="$1" bundle_root="$2" fixture_home="$3" pid executable
  for pid in $(pgrep -f "$pattern" || true); do
    smoke_is_fixture "$pid" "$fixture_home" || continue
    executable="$(readlink "${SMOKE_PROC_ROOT:-/proc}/$pid/exe" 2>/dev/null || true)"
    case "$executable" in "$bundle_root"/*) printf '%s\n' "$pid"; return 0 ;; esac
  done
  return 1
}

smoke_signal_fixture() {
  local signal="$1" fixture_home="$2" pid
  for pid in $(smoke_fixture_pids "$fixture_home"); do
    # Recheck immediately before signalling; names alone never establish ownership.
    if smoke_is_fixture "$pid" "$fixture_home"; then kill -"$signal" "$pid" 2>/dev/null || true; fi
  done
  return 0
}

smoke_is_fixture() {
  local pid="$1" fixture_home="$2" environment
  [[ "$pid" =~ ^[0-9]+$ && "$fixture_home" = /* ]] || return 1
  # Zombies and already-reaped processes have no live executable link.
  readlink "${SMOKE_PROC_ROOT:-/proc}/$pid/exe" >/dev/null 2>&1 || return 1
  environment="$(smoke_environ_of "$pid")"
  grep -Fxq -- "HOME=$fixture_home" <<<"$environment" \
    && grep -Fxq -- "CIALAI_APPIMAGE_SMOKE=$fixture_home" <<<"$environment"
}
