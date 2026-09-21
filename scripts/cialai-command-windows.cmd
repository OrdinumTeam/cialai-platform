@echo off
rem cialai-command v1
rem Abre o Cialai. Gerado pelo proprio app, apague este arquivo para remover.
rem
rem `start` desgruda do console, que volta na hora. Chamar o executavel direto
rem prenderia a janela do terminal ate o app sair.
tasklist /FI "IMAGENAME eq cialai-desktop.exe" /NH 2>nul | find /I "cialai-desktop.exe" >nul && exit /b 0
if not exist @CIALAI_LAUNCHER@ (
  echo @CIALAI_MISSING@ 1>&2
  exit /b 1
)
start "" @CIALAI_LAUNCHER@
