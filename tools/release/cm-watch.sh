#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

build_id="${1:?Uso: cm-watch.sh <build_id>}"
[[ "$build_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Build id inválido" >&2; exit 1; }
last=""

while true; do
  info="$(cm_curl "$CM_API/builds/$build_id")"
  line="$(printf '%s' "$info" | python3 -c '
import json, sys
b = json.load(sys.stdin).get("build", {})
running = [a.get("name") for a in b.get("buildActions", []) if a.get("status") == "inProgress"]
print(b.get("status", "unknown"), "|", running[0] if running else "aguardando")
')"
  if [[ "$line" != "$last" ]]; then
    printf '%s %s\n' "$(date +%H:%M:%S)" "$line"
    last="$line"
  fi
  status="${line%% *}"
  case "$status" in
    finished) echo "Build concluído"; exit 0 ;;
    failed|canceled|timeout) echo "Build terminou com status $status" >&2; exit 1 ;;
  esac
  sleep 15
done
