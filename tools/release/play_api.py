#!/usr/bin/env python3
"""Consulta o Google Play e ensaia ou publica um AAB em uma faixa."""

import json
import os
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


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("status", "upload"):
        sys.exit(__doc__)
    if sys.argv[1] == "status":
        status()
    elif len(sys.argv) < 4:
        sys.exit("uso: play_api.py upload <arquivo.aab> <faixa> [--commit]")
    else:
        upload(sys.argv[2], sys.argv[3], "--commit" in sys.argv)
