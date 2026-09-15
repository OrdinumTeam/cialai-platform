"""Audita a copia publica contra segredos e dados internos, sem imprimir valores secretos."""
import base64, json, re, sys
from collections import defaultdict
from pathlib import Path

OUT = Path(sys.argv[1])
# O Control é irmão do privado: tools/release/public-export/audit_public.py fica três pastas abaixo da raiz
SEC = Path(__file__).resolve().parents[4] / "ordinum-control/secrets"

env = dict(re.findall(r'^([A-Z_]+)="?([^"\n]*)"?$', (SEC / "ordinum/ordinum.env").read_text(), re.M))
kp = dict(re.findall(r'^(\w+)=(.*)$', (SEC / "cialai/key.properties").read_text(), re.M))
sa = json.loads((SEC / "ordinum/google-play-service-account.json").read_text())

def body_fragments(path):
    lines = [l for l in Path(path).read_text().splitlines() if l and not l.startswith("-----")]
    return [l for l in lines if len(l) >= 40][:3]

secrets = {
    "token codemagic": env["CODEMAGIC_API_TOKEN"],
    "issuer apple": env["APP_STORE_CONNECT_ISSUER_ID"],
    "key id api apple": env["APP_STORE_CONNECT_KEY_ID"],
    "key id apns": env["APNS_KEY_ID"],
    "senha keystore": kp["storePassword"],
    "private_key_id play": sa["private_key_id"],
    "client_id play": sa["client_id"],
}
for i, frag in enumerate(body_fragments(SEC / "ordinum/app-store-connect-api-key.p8")): secrets[f"corpo p8 api {i}"] = frag
for i, frag in enumerate(body_fragments(SEC / "ordinum/apns-auth-key.p8")): secrets[f"corpo p8 apns {i}"] = frag
for i, frag in enumerate(body_fragments(SEC / "ordinum/ios-distribution-cert-key.pem")): secrets[f"corpo pem ios {i}"] = frag
play_key = [l for l in sa["private_key"].splitlines() if len(l) >= 40][:3]
for i, frag in enumerate(play_key): secrets[f"corpo chave play {i}"] = frag
ks = base64.b64encode((SEC / "cialai/upload-keystore.jks").read_bytes()).decode()
secrets["keystore base64"] = ks[100:160]
updater_key = (SEC / "cialai/tauri-updater.key").read_text().strip()
secrets["chave privada do updater"] = updater_key[60:120]
secrets["corpo da chave privada do updater"] = base64.b64decode(updater_key).decode().splitlines()[1][20:80]
secrets["senha do updater"] = (SEC / "cialai/tauri-updater.password").read_text().strip()

patterns = {
    "chave privada": re.compile(r"-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?!\\nfixture)"),
    "aws access key": re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
    "github token": re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}"),
    "google api key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "slack": re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}"),
    "headscale key real": re.compile(r"\bhskey-(api|auth)-[A-Za-z0-9_-]{12}-[A-Za-z0-9_-]{30,}"),
    "tailscale key": re.compile(r"\btskey-[A-Za-z0-9-]{20,}"),
    "chave privada do updater": re.compile(r"rsign encrypted secret key|dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5"),
    "stripe ou openai": re.compile(r"\b(sk_live_|rk_live_|sk-proj-|sk-[A-Za-z0-9]{40,})"),
    "senha atribuida": re.compile(r"(?i)\b(password|passwd|senha|secret|token)\b\s*[:=]\s*['\"][^'\"\s$<{]{8,}['\"]"),
    "caminho local": re.compile(r"/Users/|focoamorim|Github Projects|Ordinum/Repos"),
    "docs internos": re.compile(r"13-progresso-e-handoff|15-credenciais-de-build|AGENTS\.md|control-source|secrets/ordinum|secrets/cialai"),
    "repo privado": re.compile(r"OrdinumTeam"),
    "conta play": re.compile(r"7730543760992383205"),
    "codemagic app id": re.compile(r"\b6a[0-9a-f]{22}\b"),
    "conta de servico": re.compile(r"[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com"),
    "clientes": re.compile(r"(?i)cowsynch|transgr|procriare|OC-00\d\d"),
    "aws infra": re.compile(r"(?i)amazonaws\.com|arn:aws:|\b\d{12}\b(?=.*(?i:aws|account))"),
}
ip = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
email = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
domain = re.compile(r"\bhttps?://([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
safe_ip = re.compile(r"^(127\.|0\.0\.0\.0|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|255\.|100\.64\.|10\.0\.0\.|1\.\d+\.\d+|\d\.\d+\.\d+\.\d+$)")

hits = defaultdict(list)
emails, domains, ips = defaultdict(set), defaultdict(set), defaultdict(set)
for file in sorted(OUT.rglob("*")):
    if not file.is_file():
        continue
    rel = str(file.relative_to(OUT))
    raw = file.read_bytes()
    text = raw.decode("utf-8", errors="ignore")
    for name, value in secrets.items():
        if value and (value in text or value.encode() in raw):
            hits["SEGREDO REAL " + name].append(rel)
    if rel.endswith("package-lock.json"):
        continue
    for name, rx in patterns.items():
        for m in rx.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            hits[name].append(f"{rel}:{line}")
    for m in email.finditer(text): emails[m.group(0).lower()].add(rel)
    for m in domain.finditer(text): domains[m.group(1).lower()].add(rel)
    for m in ip.finditer(text):
        if not safe_ip.match(m.group(0)): ips[m.group(0)].add(rel)

for name, where in sorted(hits.items()):
    print(f"== {name}: {len(where)}")
    for w in where[:12]: print("   ", w)
print("== e-mails")
for e, files in sorted(emails.items()): print("   ", e, "|", ", ".join(sorted(files)[:3]))
print("== dominios fora de listas comuns")
common = re.compile(r"(github|githubusercontent|npmjs|nodejs|rust-lang|crates|docs\.rs|golang|go\.dev|tauri|apple|google|android|expo|reactnative|mozilla|w3|schemas|json-schema|shields|contributor-covenant|apache|tailscale|headscale|letsencrypt|microsoft|example|codemagic|playwright|chromium|libreoffice|sheetjs|cloudflare|jsdelivr|unpkg|wikipedia|opensource|spdx|semver|keepachangelog|conventionalcommits|developer|yaml|mermaid|localhost)", re.I)
for d, files in sorted(domains.items()):
    if not common.search(d): print("   ", d, "|", ", ".join(sorted(files)[:3]))
print("== ips nao documentais")
for i, files in sorted(ips.items()): print("   ", i, "|", ", ".join(sorted(files)[:3]))
