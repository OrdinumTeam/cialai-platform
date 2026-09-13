#!/bin/sh
# Instala o hook em ~/.cialai e atualiza cada perfil do Claude Code.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/install-claude-statusline.py" "$@"
