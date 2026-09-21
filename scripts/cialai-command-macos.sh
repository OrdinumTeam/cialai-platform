#!/bin/sh
# cialai-command v1
# Abre o Cialai. Gerado pelo proprio app, apague este arquivo para remover.
#
# `open -b` resolve pelo identificador do pacote, entao sobrevive a renomear
# e a mover o app. Entregar ao launchd tambem faz o app nao morrer quando o
# terminal fecha, o que aconteceria chamando o executavel direto.
if open -b br.com.ordinum.cialai 2>/dev/null; then
  exit 0
fi
APP=@CIALAI_LAUNCHER@
if [ -d "$APP" ]; then
  exec open -a "$APP"
fi
printf '%s\n' @CIALAI_MISSING@ >&2
exit 1
