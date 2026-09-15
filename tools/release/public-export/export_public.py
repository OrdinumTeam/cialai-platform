"""Gera a copia publica do Cialai a partir do HEAD do repositorio privado.

Uso: python3 tools/release/public-export/export_public.py <pasta de saida>
Depois rode audit_public.py na mesma pasta e a suite completa antes de publicar.
"""
import json, re, shutil, subprocess, sys, tarfile, io
from pathlib import Path

# A raiz do privado vem do próprio arquivo: tools/release/public-export/export_public.py
SRC = Path(__file__).resolve().parents[3]
OUT = Path(sys.argv[1])

EXCLUDE = {
    "AGENTS.md",
    "docs/engenharia/13-progresso-e-handoff.md",
    "docs/engenharia/15-credenciais-de-build.md",
    "tools/check/control-source.mjs",
    "docs/evidence/control-source.json",
}

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)
archive = subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=SRC, capture_output=True, check=True).stdout
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    members = [m for m in tar.getmembers() if m.name not in EXCLUDE and not m.name.endswith(".DS_Store")
               and not re.match(r"docs/evidence/task-1\.11/control-", m.name)
               and not m.name.startswith("tools/release/public-export/")]
    tar.extractall(OUT, members=members, filter="data")
shutil.copy2(SRC / ".github/README.md", OUT / ".github/README.md")
shutil.copy2(Path(__file__).with_name("public-evidence-readme.md"), OUT / "docs/evidence/task-1.11/README.md")
shutil.copytree(SRC / ".github/assets", OUT / ".github/assets", dirs_exist_ok=True)


def edit(path, pairs, count_required=True):
    file = OUT / path
    text = file.read_text(encoding="utf-8")
    for old, new in pairs:
        if isinstance(old, re.Pattern):
            text, n = old.subn(new, text)
        else:
            n = text.count(old)
            text = text.replace(old, new)
        if count_required and n == 0:
            raise SystemExit(f"trecho nao encontrado em {path}: {str(old)[:80]}")
    file.write_text(text, encoding="utf-8")


pkg = json.loads((OUT / "package.json").read_text())
pkg["scripts"].pop("check:source", None)
(OUT / "package.json").write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n")

edit("README.md", [(
    "See the [execution handoff](./docs/engenharia/13-progresso-e-handoff.md) for exact evidence and remaining external work.",
    "See the [roadmap](./docs/produto/11-roadmap-de-execucao.md) for the state of each task and the remaining external work.",
)])
edit(".github/README.md", [(
    "The live record with commands and results is [docs/engenharia/13-progresso-e-handoff.md](../docs/engenharia/13-progresso-e-handoff.md).",
    "Task states are tracked in the [roadmap](../docs/produto/11-roadmap-de-execucao.md).",
)])
edit("CONTRIBUTING.md", [
    ("Read the [execution handoff](docs/engenharia/13-progresso-e-handoff.md) first. The [roadmap](docs/produto/11-roadmap-de-execucao.md) records task dependencies and acceptance criteria.",
     "Read the [roadmap](docs/produto/11-roadmap-de-execucao.md) first. It records task dependencies and acceptance criteria."),
    ("- Update `docs/engenharia/13-progresso-e-handoff.md` after each delivery, relevant test or blocker.",
     "- Update the task state in `docs/produto/11-roadmap-de-execucao.md` when a delivery changes it."),
])
edit("codemagic.yaml", [(
    "# Grupos e credenciais estão descritos em docs/engenharia/15-credenciais-de-build.md.",
    "# Grupos e credenciais são configurados no Codemagic por quem mantém a publicação dos apps.",
)])
edit("tools/spikes/README.md", [(
    "em `docs/engenharia/13-progresso-e-handoff.md` e em `docs/produto/12-decisoes.md`",
    "em `docs/produto/12-decisoes.md`",
)])
edit("docs/README.md", [
    (" Para retomar o trabalho, leia primeiro [13 Progresso e handoff](./engenharia/13-progresso-e-handoff.md); ele diferencia entregas locais de evidências externas.", ""),
    (re.compile(r"^\| 13 \| \[Progresso e handoff\]\(\./engenharia/13-progresso-e-handoff\.md\).*\n", re.M), ""),
    (re.compile(r"^\| 15 \| \[Credenciais de build\]\(\./engenharia/15-credenciais-de-build\.md\).*\n", re.M), ""),
    (re.compile(r"^\| `\$CONTROL` \|.*$", re.M), "| `$CONTROL` | Ordinum Control, o protótipo interno de onde o estúdio foi extraído; não é publicado |"),
    (re.compile(r"^\| `\$CIALAI` \|.*$", re.M), "| `$CIALAI` | Raiz deste repositório |"),
    (re.compile(r"^\| `\$ADVORIS` \|.*$", re.M), "| `$ADVORIS` | App interno da Ordinum usado como referência de publicação nas lojas; não é publicado |"),
    (re.compile(r"^\| `\$MARCA` \|.*$", re.M), "| `$MARCA` | Pasta `brand` deste repositório, com a identidade visual |"),
])
edit("docs/engenharia/10-ci-cd-e-distribuicao.md", [
    (re.compile(r"## Repositórios\n.*?(?=## Estado em)", re.S), ""),
    (re.compile(r"^\| App no Codemagic \|.*\n", re.M), ""),
    (re.compile(r"^\| Conta de serviço do Play \|.*\n", re.M), ""),
    (re.compile(r"^\| Referências existentes \|.*\n", re.M), ""),
    (re.compile(r"Criado em 13/09/2026 na conta `\d+`, "), "Criado em 13/09/2026, "),
])

edit("docs/engenharia/10-ci-cd-e-distribuicao.md", [("idênticos aos do Advoris e do CowSynch", "idênticos aos de outros apps da Ordinum")])
edit("docs/produto/02-analise-do-prototipo.md", [
    ("Commit base e hashes dos oito arquivos modificados estão em `docs/evidence/control-source.json`", "Commit base e hashes dos oito arquivos modificados ficaram num inventário interno"),
    ("Raízes `Github Projects/OrdinumTeam` e `OrdinumCustomers`", "Raízes de projetos fixas do ambiente interno"),
])
edit("docs/produto/12-decisoes.md", [("em `docs/evidence/control-source.json`", "num inventário interno")])
edit("tools/release/.env.example", [(re.compile(r"^GOOGLE_PLAY_ACCOUNT_ID=\d+$", re.M), "GOOGLE_PLAY_ACCOUNT_ID=")])

local = re.compile(r"/Users/[A-Za-z0-9._-]+/(?:Github Projects|Ordinum/Repos)/OrdinumTeam/(ordinum-control|cialai-platform|advoris-mobile|ordinum-marketing/projects/CIALAI)")
names = {"ordinum-control": "$CONTROL", "cialai-platform": "$CIALAI", "advoris-mobile": "$ADVORIS", "ordinum-marketing/projects/CIALAI": "$MARCA"}
for file in OUT.rglob("*"):
    if not file.is_file() or file.suffix.lower() in {".png", ".webp", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".jar", ".aar", ".zip", ".pdf", ".rtf"}:
        continue
    try:
        text = file.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    new = local.sub(lambda m: names[m.group(1)], text)
    new = new.replace("/Users/focoamorim/", "~/")
    if new != text:
        file.write_text(new, encoding="utf-8")
        print("caminho local saneado:", file.relative_to(OUT))

print("arquivos exportados:", sum(1 for f in OUT.rglob("*") if f.is_file()))
