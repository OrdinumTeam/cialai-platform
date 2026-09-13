#!/usr/bin/env python3
"""Instala o hook do Cialai nos perfis locais do Claude Code."""

import argparse
import datetime
import json
import os
import pathlib
import shutil
import sys


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--home", type=pathlib.Path, default=pathlib.Path.home(), help=argparse.SUPPRESS)
    parser.add_argument("--platform", choices=("posix", "windows"), default="windows" if os.name == "nt" else "posix", help=argparse.SUPPRESS)
    parser.add_argument("--python-command", default="python", help=argparse.SUPPRESS)
    return parser.parse_args()


def write_settings(path, target, force, dry_run, platform, python_command):
    label = str(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"{label}: JSON inválido, não alterado: {error}")
        return
    if not isinstance(data, dict):
        print(f"{label}: conteúdo inesperado, não alterado")
        return
    command = str(target) if platform == "posix" else f'{python_command} "{target}"'
    wanted = {"type": "command", "command": command, "padding": 0}
    current = data.get("statusLine")
    if current == wanted:
        print(f"{label}: já instalado")
        return
    if current and not force:
        print(f"{label}: statusLine próprio mantido")
        return
    if dry_run:
        print(f"{label}: gravaria statusLine")
        return
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(path, pathlib.Path(f"{path}.bak-{stamp}"))
    data["statusLine"] = wanted
    temporary = pathlib.Path(f"{path}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    print(f"{label}: statusLine instalado")


def main():
    args = arguments()
    source = pathlib.Path(__file__).with_name("claude-statusline.py")
    target = args.home / ".cialai" / "claude-statusline.py"
    print(f"Os settings do Claude Code em {args.home} podem ser alterados.")
    if not source.is_file():
        print(f"Hook não encontrado em {source}", file=sys.stderr)
        return 1
    if args.dry_run:
        print(f"Hook seria copiado para {target}")
    elif not target.is_file() or source.read_bytes() != target.read_bytes():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if args.platform == "posix":
            target.chmod(0o755)
        print(f"Hook copiado para {target}")
    else:
        print(f"Hook já atualizado em {target}")

    profiles = [args.home / ".claude"]
    profiles.extend(sorted(path for path in args.home.glob(".claude-*") if path.is_dir()))
    for profile in profiles:
        settings = profile / "settings.json"
        if settings.is_file():
            write_settings(
                settings,
                target,
                args.force,
                args.dry_run,
                args.platform,
                args.python_command,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
