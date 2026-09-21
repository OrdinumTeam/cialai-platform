#!/usr/bin/env bash
# Baixa um artifact de um build do Codemagic pelo final do nome.
#
# O cm-log.sh baixa o pacote de logs; este baixa o arquivo de entrega, que é o
# que a release precisa anexar. Uso:
#   cm-artifact.sh BUILD_ID .apk /caminho/Cialai_android_universal.apk
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

build_id="${1:?informe o build id}"
sufixo="${2:?informe o final do nome, por exemplo .apk}"
destino="${3:?informe o caminho de destino}"
[[ "$build_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Build id inválido" >&2; exit 1; }

json="$(cm_curl "$CM_API/builds/$build_id")"
url="$(printf '%s' "$json" | CM_SUFIXO="$sufixo" python3 -c '
import json, os, sys
sufixo = os.environ["CM_SUFIXO"]
build = json.load(sys.stdin).get("build", {})
for artifact in build.get("artefacts", []):
    nome = str(artifact.get("name", ""))
    if nome.endswith(sufixo):
        print(artifact.get("url", ""))
        break
')"
[[ -n "$url" ]] || {
  echo "O build $build_id não tem artifact terminando em $sufixo" >&2
  printf '%s' "$json" | python3 -c '
import json, sys
for a in json.load(sys.stdin).get("build", {}).get("artefacts", []):
    print("  disponível:", a.get("name"), file=sys.stderr)
'
  exit 1
}

mkdir -p "$(dirname "$destino")"
cm_download "$url" "$destino"
[[ -s "$destino" ]] || { echo "O download ficou vazio" >&2; exit 1; }
printf '%s\n' "$destino"
