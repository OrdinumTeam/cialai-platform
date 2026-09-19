# SPDX-License-Identifier: Apache-2.0
# Junta o que explica uma abertura quebrada do Cialai no Windows num arquivo
# compactado na área de trabalho, para quem relatou o problema enviar sem
# precisar procurar nada.
#
# O que entra: os registros do app e do túnel, a versão e o build do Windows,
# a versão do WebView2 Runtime, o nome da placa de vídeo, a escala da tela, o
# ajuste de efeitos de transparência e a versão instalada do Cialai.
#
# O que nunca entra: chave, token, cookie, arquivo de credencial e a pasta de
# identidade do túnel. Os registros são copiados como estão, então confira o
# arquivo antes de enviar.
#
# Uso, numa janela do PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\collect-diagnostics.ps1

[CmdletBinding()]
param(
    [string] $Destino = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$identificador = 'br.com.ordinum.cialai'
$carimbo = Get-Date -Format 'yyyyMMdd-HHmmss'
$pasta = Join-Path ([System.IO.Path]::GetTempPath()) "cialai-diagnostico-$carimbo"
New-Item -ItemType Directory -Path $pasta -Force | Out-Null

function Escrever($nome, $conteudo) {
    $caminho = Join-Path $pasta $nome
    $conteudo | Out-File -FilePath $caminho -Encoding utf8
}

# ── registros ────────────────────────────────────────────────────────
$local = Join-Path $env:LOCALAPPDATA $identificador
$logs = Join-Path $local 'logs'
$copiados = @()
foreach ($nome in @('app.log', 'app.log.1')) {
    $origem = Join-Path $logs $nome
    if (Test-Path $origem) {
        Copy-Item $origem (Join-Path $pasta $nome) -ErrorAction SilentlyContinue
        $copiados += $nome
    }
}
$tunel = Join-Path $local 'tunnel\tunnel.log'
if (Test-Path $tunel) {
    Copy-Item $tunel (Join-Path $pasta 'tunnel.log') -ErrorAction SilentlyContinue
    $copiados += 'tunnel.log'
}

# ── ambiente ─────────────────────────────────────────────────────────
$sistema = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$video = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    ForEach-Object { "$($_.Name); driver $($_.DriverVersion)" })

$webview = 'não encontrado'
$chaves = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
foreach ($chave in $chaves) {
    $valor = (Get-ItemProperty -Path $chave -Name pv -ErrorAction SilentlyContinue).pv
    if ($valor) { $webview = $valor; break }
}

$transparencia = (Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency -ErrorAction SilentlyContinue).EnableTransparency
$escala = 'desconhecida'
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $dpi = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
    if ($dpi) { $escala = "$([math]::Round($dpi / 96 * 100))%" }
} catch { }

$instalado = 'não encontrado'
foreach ($raiz in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $achado = Get-ItemProperty $raiz -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like '*Cialai*' } |
        Select-Object -First 1
    if ($achado) { $instalado = "$($achado.DisplayName) $($achado.DisplayVersion)"; break }
}

$relatorio = @"
Cialai: diagnóstico do Windows
Gerado em: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')

Sistema
  Edição: $($sistema.Caption)
  Versão: $($sistema.Version)
  Build: $($sistema.BuildNumber)
  Arquitetura: $($sistema.OSArchitecture)
  Nome do computador: $env:COMPUTERNAME

Tela
  Escala: $escala
  Efeitos de transparência: $transparencia

Vídeo
  $($video -join "`n  ")

WebView2 Runtime
  Versão: $webview

Cialai
  Instalação: $instalado
  Pasta de dados local: $local
  Registros incluídos: $(if ($copiados) { $copiados -join ', ' } else { 'nenhum' })

PowerShell
  Versão: $($PSVersionTable.PSVersion)
"@
Escrever 'ambiente.txt' $relatorio

# ── empacotar ────────────────────────────────────────────────────────
$arquivo = Join-Path $Destino "cialai-diagnostico-$carimbo.zip"
if (Test-Path $arquivo) { Remove-Item $arquivo -Force }
Compress-Archive -Path (Join-Path $pasta '*') -DestinationPath $arquivo -Force
Remove-Item $pasta -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Diagnóstico pronto.'
Write-Host "Arquivo: $arquivo"
Write-Host 'Confira o conteúdo antes de enviar. Nenhuma chave ou credencial é coletada.'
Write-Host ''
