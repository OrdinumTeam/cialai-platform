#!/usr/bin/env python3
"""Consulta o Google Play e ensaia ou publica um AAB em uma faixa.

  play_api.py status
  play_api.py upload <arquivo.aab> <faixa> [--commit]
  play_api.py release <versionCode> <versao> <faixa> [--commit]

`release` leva a uma faixa um versionCode que ja esta na biblioteca, como o
AAB que o Codemagic sobe como rascunho na faixa interna, com o nome da versao
e as notas dos blocos PLAY_RELEASE de docs/stores/listing-*.md. Sem
`--commit` o edit e validado e descartado. Os paises ficam na faixa.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stores import curl, env, token_play  # noqa: E402

PACKAGE = env("ANDROID_PACKAGE")
BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PACKAGE
UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/" + PACKAGE
TRACKS = ("internal", "alpha", "beta", "production")


def api(access_token, method, path, body=None, file_path=None, base=None):
    args = ["-X", method, "-H", "Authorization: Bearer " + access_token]
    if file_path:
        args += ["-H", "Content-Type: application/octet-stream", "--data-binary", "@" + file_path]
    elif body is not None:
        args += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    else:
        args += ["-H", "Content-Length: 0"]
    return curl(args + [(base or BASE) + path])


def require_result(result, step):
    code, body = result
    if code not in ("200", "204"):
        sys.exit("falhou em %s: HTTP %s\n%s" % (step, code, body[:500]))
    return json.loads(body) if body else {}


def status():
    access_token = token_play()
    edit_id = require_result(api(access_token, "POST", "/edits"), "criar edit")["id"]
    try:
        tracks = require_result(api(access_token, "GET", "/edits/%s/tracks" % edit_id), "ler faixas")
        print("Faixas de %s" % PACKAGE)
        for track in tracks.get("tracks", []):
            releases = track.get("releases") or []
            if not releases:
                print("  %-12s vazia" % track.get("track"))
            for release in releases:
                print("  %-12s versionCodes %s | %s | nome %s" % (
                    track.get("track"), release.get("versionCodes"),
                    release.get("status"), release.get("name")))
    finally:
        api(access_token, "DELETE", "/edits/%s" % edit_id)


def upload(file_path, track, commit):
    if not os.path.isfile(file_path):
        sys.exit("arquivo não encontrado: " + file_path)
    if track not in TRACKS:
        sys.exit("faixa inválida: " + track)
    access_token = token_play()
    edit_id = require_result(api(access_token, "POST", "/edits"), "criar edit")["id"]
    published = False
    try:
        bundle = require_result(api(access_token, "POST", "/edits/%s/bundles?uploadType=media" % edit_id,
                                    file_path=file_path, base=UPLOAD), "subir bundle")
        version_code = bundle.get("versionCode")
        require_result(api(access_token, "PUT", "/edits/%s/tracks/%s" % (edit_id, track), body={
            "track": track,
            "releases": [{"versionCodes": [str(version_code)], "status": "completed"}],
        }), "atribuir faixa")
        if commit:
            require_result(api(access_token, "POST", "/edits/%s:commit" % edit_id), "publicar edit")
            published = True
            print("Publicado na faixa %s" % track)
        else:
            print("Ensaio concluído e edit descartado sem publicação")
    finally:
        if not published:
            api(access_token, "DELETE", "/edits/%s" % edit_id)


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Idioma da ficha do Play e o arquivo de onde sai a nota daquela lingua.
NOTAS = (("pt-BR", "docs/stores/listing-pt-BR.md"), ("en-US", "docs/stores/listing-en.md"))
LIMITE_NOTAS = 500


def play_notes():
    notas = []
    for idioma, caminho in NOTAS:
        with open(os.path.join(REPO_ROOT, caminho), encoding="utf-8") as fonte:
            texto = fonte.read()
        achado = re.search(r"<!-- PLAY_RELEASE_START -->\s*```text\n([\s\S]*?)\n```\s*<!-- PLAY_RELEASE_END -->", texto)
        if not achado:
            sys.exit("falta o bloco PLAY_RELEASE em " + caminho)
        nota = achado.group(1).strip()
        if len(nota) > LIMITE_NOTAS:
            sys.exit("nota de %s com %d caracteres, o Play aceita %d" % (idioma, len(nota), LIMITE_NOTAS))
        notas.append({"language": idioma, "text": nota})
    return notas


def release(version_code, name, track, commit):
    if not version_code.isdigit():
        sys.exit("versionCode invalido: " + version_code)
    if not re.fullmatch(r"\d+\.\d+\.\d+", name):
        sys.exit("versao fora do formato x.y.z: " + name)
    if track not in TRACKS:
        sys.exit("faixa invalida: " + track)
    access_token = token_play()
    edit_id = require_result(api(access_token, "POST", "/edits"), "criar edit")["id"]
    published = False
    try:
        bundles = require_result(api(access_token, "GET", "/edits/%s/bundles" % edit_id), "ler biblioteca")
        codes = {str(bundle.get("versionCode")) for bundle in bundles.get("bundles", [])}
        if version_code not in codes:
            sys.exit("o versionCode %s nao esta na biblioteca do Play" % version_code)
        require_result(api(access_token, "PUT", "/edits/%s/tracks/%s" % (edit_id, track), body={
            "track": track,
            "releases": [{"versionCodes": [version_code], "status": "completed", "name": name,
                          "releaseNotes": play_notes()}],
        }), "atribuir faixa")
        require_result(api(access_token, "POST", "/edits/%s:validate" % edit_id), "validar edit")
        if commit:
            require_result(api(access_token, "POST", "/edits/%s:commit" % edit_id), "publicar edit")
            published = True
            print("versionCode %s publicado na faixa %s como %s" % (version_code, track, name))
        else:
            print("Ensaio validado e descartado: versionCode %s na faixa %s como %s" % (version_code, track, name))
    finally:
        if not published:
            api(access_token, "DELETE", "/edits/%s" % edit_id)


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("status", "upload", "release"):
        sys.exit(__doc__)
    if sys.argv[1] == "status":
        status()
    elif sys.argv[1] == "release":
        if len(sys.argv) < 5:
            sys.exit("uso: play_api.py release <versionCode> <versao> <faixa> [--commit]")
        release(sys.argv[2], sys.argv[3], sys.argv[4], "--commit" in sys.argv)
    elif len(sys.argv) < 4:
        sys.exit("uso: play_api.py upload <arquivo.aab> <faixa> [--commit]")
    else:
        upload(sys.argv[2], sys.argv[3], "--commit" in sys.argv)
