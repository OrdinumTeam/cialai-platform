#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

workflow="${1:-$CODEMAGIC_WORKFLOW_ID}"
branch="${2:-$CODEMAGIC_BRANCH}"
case "$workflow" in
  ios-testflight|ios-archive|android-play) ;;
  *) echo "Workflow inválido: $workflow" >&2; exit 1 ;;
esac
[[ -n "$branch" ]] || { echo "A branch é obrigatória" >&2; exit 1; }

payload="$(CM_APP="$CODEMAGIC_APP_ID" CM_WORKFLOW="$workflow" CM_BRANCH="$branch" python3 -c '
import json, os
print(json.dumps({"appId": os.environ["CM_APP"], "workflowId": os.environ["CM_WORKFLOW"], "branch": os.environ["CM_BRANCH"]}))
')"
response="$(cm_curl -X POST "$CM_API/builds" -H 'Content-Type: application/json' --data "$payload")"
build_id="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("buildId", ""))')"
[[ "$build_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "O Codemagic não devolveu um build id válido" >&2; exit 1; }
printf '%s\n' "$build_id"
