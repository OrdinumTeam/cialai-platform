# Instala o hook em %USERPROFILE%\.cialai e atualiza os perfis do Claude Code.
$ErrorActionPreference = "Stop"
$Installer = Join-Path $PSScriptRoot "install-claude-statusline.py"

if (Get-Command python -ErrorAction SilentlyContinue) {
  & python $Installer --platform windows --python-command python @args
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 $Installer --platform windows --python-command "py -3" @args
} else {
  Write-Error "Python 3 não encontrado"
  exit 1
}
exit $LASTEXITCODE
