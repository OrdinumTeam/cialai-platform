#!/bin/sh
# cialai-command v1
# Abre o Cialai. Gerado pelo proprio app, apague este arquivo para remover.
#
# Nao ha equivalente ao `open` do macOS, entao o executavel e chamado direto.
# Como o app nao tem instancia unica, a guarda abaixo evita um segundo
# processo disputando as preferencias, o diario de terminais, a porta do tunel
# e o perfil do Dev Browser. `setsid` desgruda do terminal, para fechar a aba
# nao derrubar o app.
APP=@CIALAI_LAUNCHER@
if command -v pgrep >/dev/null 2>&1 && pgrep -x -u "$(id -u)" cialai-desktop >/dev/null 2>&1; then
  exit 0
fi
if [ ! -x "$APP" ]; then
  printf '%s\n' @CIALAI_MISSING@ >&2
  exit 1
fi
if command -v setsid >/dev/null 2>&1; then
  setsid "$APP" >/dev/null 2>&1 </dev/null &
else
  nohup "$APP" >/dev/null 2>&1 </dev/null &
fi
exit 0
