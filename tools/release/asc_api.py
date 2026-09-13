#!/usr/bin/env python3
"""Consulta builds, versões e TestFlight sem alterar a App Store Connect."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stores import curl, env, token_apple  # noqa: E402

APP = env("APP_STORE_APP_ID")
API = "https://api.appstoreconnect.apple.com"


def get(access_token, path):
    code, body = curl(["-H", "Authorization: Bearer " + access_token, API + path])
    if code != "200":
        sys.exit("HTTP %s em %s\n%s" % (code, path, body[:400]))
    return json.loads(body)


def builds(access_token, limit=5):
    data = get(access_token, "/v1/builds?filter[app]=%s&limit=%d&sort=-uploadedDate" % (APP, limit))
    print("Builds do app %s" % APP)
    for build in data.get("data", []):
        attributes = build.get("attributes", {})
        print("  build %-4s %-12s enviado %s" % (
            attributes.get("version"), attributes.get("processingState"),
            (attributes.get("uploadedDate") or "")[:19]))
    return data


def versions(access_token):
    data = get(access_token, "/v1/apps/%s/appStoreVersions?limit=5" % APP)
    print("Versões na App Store")
    for version in data.get("data", []):
        attributes = version.get("attributes", {})
        print("  %-8s %s" % (attributes.get("versionString"), attributes.get("appStoreState")))


def testflight(access_token):
    data = get(access_token, "/v1/builds?filter[app]=%s&limit=1&sort=-uploadedDate" % APP)
    items = data.get("data", [])
    if not items:
        print("nenhum build")
        return
    build_id = items[0]["id"]
    version = items[0]["attributes"].get("version")
    detail = get(access_token, "/v1/builds/%s/buildBetaDetail" % build_id)
    attributes = (detail.get("data") or {}).get("attributes", {})
    print("Build %s no TestFlight" % version)
    print("  interno:", attributes.get("internalBuildState"))
    print("  externo:", attributes.get("externalBuildState"))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command not in ("builds", "versions", "testflight"):
        sys.exit(__doc__)
    token = token_apple()
    {"builds": builds, "versions": versions, "testflight": testflight}[command](token)
