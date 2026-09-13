#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

build_id="${1:-$(cm_latest_build_id)}"
mode="${2:-}"
[[ "$build_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Build id inválido ou inexistente" >&2; exit 1; }
[[ -z "$mode" || "$mode" == "--download" ]] || { echo "Opção inválida: $mode" >&2; exit 1; }

json="$(cm_curl "$CM_API/builds/$build_id")"
printf '%s' "$json" | python3 -c '
import json, sys
b = json.load(sys.stdin).get("build", {})
commit = b.get("commit") or {}
print("status:", b.get("status"))
print("branch:", b.get("branch"), "| commit:", str(commit.get("hash", ""))[:10])
for action in b.get("buildActions", []):
    print(" ", action.get("status"), action.get("name"))
print("artifacts:")
for artifact in b.get("artefacts", []):
    print(" ", artifact.get("name"))
'

[[ "$mode" == "--download" ]] || exit 0
selection="$(printf '%s' "$json" | python3 -c '
import json, sys
b = json.load(sys.stdin).get("build", {})
items = b.get("artefacts", [])
selected = next((a for a in items if str(a.get("name", "")).endswith(".zip")), None)
if selected is None:
    selected = next((a for a in items if str(a.get("name", "")).endswith(".log")), None)
if selected:
    print(("zip" if str(selected.get("name", "")).endswith(".zip") else "log") + "\t" + str(selected.get("url", "")))
')"
[[ -n "$selection" ]] || { echo "Nenhum pacote de logs está disponível para download" >&2; exit 1; }

kind="${selection%%$'\t'*}"
url="${selection#*$'\t'}"
output_dir="$(mktemp -d "/tmp/cialai-codemagic.${build_id}.XXXXXX")"
if [[ "$kind" == "zip" ]]; then
  cm_download "$url" "$output_dir/artifacts.zip"
  unzip -q "$output_dir/artifacts.zip" -d "$output_dir"
else
  cm_download "$url" "$output_dir/build.log"
fi
printf 'Logs baixados em %s\n' "$output_dir"
