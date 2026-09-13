"""Autenticação da App Store Connect por variáveis do ambiente."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def env(name: str, required: bool = True) -> str:
    value = os.environ.get(name)
    if value:
        return value
    path = os.environ.get("CIALAI_RELEASE_ENV_FILE", os.path.join(REPO_ROOT, ".env"))
    if os.path.exists(path):
        with open(path, encoding="utf-8") as source:
            for line in source:
                match = re.match(r"^" + re.escape(name) + r"=(.*)$", line.strip())
                if match:
                    value = match.group(1).split("#")[0].strip()
                    if value:
                        return value
    if required:
        sys.exit("faltando %s no ambiente ou no arquivo local configurado" % name)
    return ""


def _b64(data: bytes) -> bytes:
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def curl(args: list[str]) -> tuple[str, str]:
    result = subprocess.run(
        ["curl", "-sS", "-g", "--http1.1", "--retry", "3", "--retry-all-errors",
         "-w", "\n__C__%{http_code}"] + args,
        capture_output=True, text=True, check=False,
    )
    body, _, code = result.stdout.rpartition("__C__")
    if not code:
        return "000", (result.stderr or body)[:400]
    return code.strip(), body.strip()


def token_apple() -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    issuer = env("APP_STORE_CONNECT_ISSUER_ID")
    key_id = env("APP_STORE_CONNECT_KEY_ID")
    path = env("APP_STORE_CONNECT_PRIVATE_KEY_PATH")
    if not os.path.isabs(path):
        path = os.path.join(REPO_ROOT, path)
    if not os.path.exists(path):
        sys.exit("chave da App Store Connect não encontrada em " + path)

    with open(path, "rb") as source:
        key = serialization.load_pem_private_key(source.read(), password=None)
    now = int(time.time())
    header = _b64(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64(json.dumps({"iss": issuer, "iat": now, "exp": now + 900,
                               "aud": "appstoreconnect-v1"}, separators=(",", ":")).encode())
    first, second = decode_dss_signature(key.sign(header + b"." + payload, ec.ECDSA(hashes.SHA256())))
    signature = _b64(first.to_bytes(32, "big") + second.to_bytes(32, "big"))
    return (header + b"." + payload + b"." + signature).decode()
