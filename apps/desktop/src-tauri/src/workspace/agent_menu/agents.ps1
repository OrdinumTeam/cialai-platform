# SPDX-License-Identifier: Apache-2.0
# Cialai: menu de contas ao digitar codex ou claude nas sessoes do Cialai.
# O app passa este script ao PowerShell por -EncodedCommand, que roda depois
# do perfil do usuario e nao depende da politica de execucao. Mesmo contrato
# de agents.zsh: contas em ~/.cialai/agents/<agente>.tsv e `codex +nome`.

$global:CialaiAgentsDir = if ($env:CIALAI_AGENTS_DIR) { $env:CIALAI_AGENTS_DIR } else { Join-Path $HOME '.cialai/agents' }

function global:__CialaiAgentsLines([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  return @(Get-Content -LiteralPath $Path -Encoding UTF8)
}

function global:__CialaiAgentsText([string]$Key, [string]$Name) {
  $text = ''
  foreach ($line in (__CialaiAgentsLines (Join-Path $global:CialaiAgentsDir 'menu.tsv'))) {
    $fields = $line -split "`t", 2
    if ($fields.Count -eq 2 -and $fields[0] -eq $Key) { $text = $fields[1]; break }
  }
  if (-not $text) {
    $text = switch ($Key) { 'question' { '?' } 'enter' { 'Enter: {name}' } default { '{name}?' } }
  }
  return $text.Replace('{name}', $Name)
}

function global:__CialaiAgentsRows([string]$Agent) {
  $rows = @()
  foreach ($line in (__CialaiAgentsLines (Join-Path $global:CialaiAgentsDir "$Agent.tsv"))) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $fields = $line -split "`t"
    if ($fields.Count -lt 6) { continue }
    $rows += [pscustomobject]@{
      Name = $fields[0]; Label = $fields[1]; Dir = $fields[2]; State = $fields[3]
      Value = $(if ($fields[4] -eq '-') { '' } else { $fields[4] })
      Detail = $(if ($fields[5] -eq '-') { '' } else { $fields[5] })
    }
  }
  return ,$rows
}

function global:__CialaiAgentsSkip([string]$Agent, [object[]]$Rest) {
  if ($Rest.Count -gt 0 -and @('--version', '-v', '-V', '--help', '-h') -ccontains [string]$Rest[0]) { return $true }
  if ($Agent -eq 'codex') {
    if ($Rest.Count -gt 0 -and @('login', 'logout') -ccontains [string]$Rest[0]) { return $true }
    return ($Rest.Count -ge 2 -and [string]$Rest[0] -eq 'resume' -and -not ([string]$Rest[1]).StartsWith('-'))
  }
  if ($Rest.Count -gt 0 -and @('auth', 'setup-token') -ccontains [string]$Rest[0]) { return $true }
  for ($index = 0; $index -lt $Rest.Count; $index++) {
    $value = [string]$Rest[$index]
    if ($value -like '--resume=?*') { return $true }
    if (($value -eq '--resume' -or $value -eq '-r') -and $index + 1 -lt $Rest.Count -and -not ([string]$Rest[$index + 1]).StartsWith('-')) { return $true }
  }
  return $false
}

# Devolve a conta escolhida ou 'skip', 'missing' e 'cancel'.
function global:__CialaiAgentsPick([string]$Agent, [string]$Wanted) {
  $rows = __CialaiAgentsRows $Agent
  if ($Wanted) {
    foreach ($row in $rows) { if ($row.Name -eq $Wanted -or $row.Label -eq $Wanted) { return $row } }
    return 'missing'
  }
  if ($rows.Count -lt 2) { return 'skip' }

  $here = (Get-Location).Path
  $last = ''
  foreach ($line in (__CialaiAgentsLines (Join-Path $global:CialaiAgentsDir "$Agent.last"))) {
    $fields = $line -split "`t", 2
    if ($fields.Count -eq 2 -and $fields[0] -eq $here) { $last = $fields[1] }
  }
  $start = 0
  for ($index = 0; $index -lt $rows.Count; $index++) { if ($rows[$index].Name -eq $last) { $start = $index } }
  $choice = $start
  for ($step = 0; $step -lt $rows.Count; $step++) {
    $index = ($start + $step) % $rows.Count
    if ($rows[$index].State -ne 'out' -and $rows[$index].State -ne 'none') { $choice = $index; break }
  }

  $esc = [char]27
  $width = ($rows | ForEach-Object { $_.Label.Length } | Measure-Object -Maximum).Maximum
  [Console]::Error.WriteLine("$esc[1m$(__CialaiAgentsText 'question' '')$esc[0m")
  for ($index = 0; $index -lt $rows.Count; $index++) {
    $row = $rows[$index]
    $mark = if ($index -eq $choice) { "$esc[38;5;211m>$esc[0m" } else { ' ' }
    $tone = switch ($row.State) { 'out' { "$esc[31m" } 'free' { "$esc[32m" } default { "$esc[2m" } }
    [Console]::Error.WriteLine("$mark $($index + 1)  $($row.Label.PadRight($width))  $tone$($row.Value)$esc[0m  $esc[2m$($row.Detail)$esc[0m")
  }
  [Console]::Error.WriteLine("$esc[2m$(__CialaiAgentsText 'enter' $rows[$choice].Label)$esc[0m")

  if ($rows.Count -gt 9) {
    $answer = [Console]::ReadLine()
  } else {
    $key = [Console]::ReadKey($true)
    $answer = if ($key.Key -eq [ConsoleKey]::Enter) { '' } else { [string]$key.KeyChar }
  }
  if ($answer -eq '') { return $rows[$choice] }
  $number = 0
  if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $rows.Count) { return $rows[$number - 1] }
  return 'cancel'
}

function global:__CialaiAgentsRemember([string]$Agent, [string]$Name) {
  if (-not (Test-Path -LiteralPath $global:CialaiAgentsDir)) { return }
  $path = Join-Path $global:CialaiAgentsDir "$Agent.last"
  try {
    Add-Content -LiteralPath $path -Value ("{0}`t{1}" -f (Get-Location).Path, $Name) -Encoding UTF8
    $lines = __CialaiAgentsLines $path
    if ($lines.Count -gt 400) { $lines | Select-Object -Last 200 | Set-Content -LiteralPath $path -Encoding UTF8 }
  } catch { }
}

function global:__CialaiAgentsCall([string]$Agent, [object[]]$Rest) {
  $user = Get-Item "function:__cialai_user_$Agent" -ErrorAction SilentlyContinue
  if ($user) { & $user.ScriptBlock @Rest; return }
  $command = Get-Command $Agent -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { & $command @Rest } else { [Console]::Error.WriteLine("$Agent ?") }
}

function global:__CialaiAgentsRun([string]$Agent, [string]$DirKey, [string]$NameKey, [object[]]$Rest) {
  if ($null -eq $Rest) { $Rest = @() }
  $wanted = ''
  if ($Rest.Count -gt 0 -and ([string]$Rest[0]) -match '^\+.+') {
    $wanted = ([string]$Rest[0]).Substring(1)
    $Rest = @($Rest | Select-Object -Skip 1)
  } elseif ([Environment]::GetEnvironmentVariable($DirKey) -or $env:CIALAI_AGENT_MENU -eq '0' -or [Console]::IsInputRedirected -or [Console]::IsErrorRedirected -or (__CialaiAgentsSkip $Agent $Rest)) {
    __CialaiAgentsCall $Agent $Rest
    return
  }
  $pick = __CialaiAgentsPick $Agent $wanted
  if ($pick -is [string]) {
    switch ($pick) {
      'skip' { __CialaiAgentsCall $Agent $Rest }
      'missing' { [Console]::Error.WriteLine((__CialaiAgentsText 'missing' $wanted)); $global:LASTEXITCODE = 2 }
      default { [Console]::Error.WriteLine(); $global:LASTEXITCODE = 130 }
    }
    return
  }
  __CialaiAgentsRemember $Agent $pick.Name
  $saved = @{ $DirKey = [Environment]::GetEnvironmentVariable($DirKey); $NameKey = [Environment]::GetEnvironmentVariable($NameKey) }
  try {
    if ($pick.Dir -eq '-') {
      Remove-Item "Env:$DirKey", "Env:$NameKey" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$DirKey" $pick.Dir
      Set-Item "Env:$NameKey" $pick.Name
    }
    __CialaiAgentsCall $Agent $Rest
  } finally {
    foreach ($name in $saved.Keys) {
      if ($null -eq $saved[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $saved[$name] }
    }
  }
}

# Uma funcao do usuario com o mesmo nome continua valendo: ela passa a rodar
# depois do menu.
foreach ($agent in 'codex', 'claude') {
  $existing = Get-Item "function:$agent" -ErrorAction SilentlyContinue
  if ($existing -and $existing.ScriptBlock.ToString() -notmatch '__CialaiAgentsRun') {
    Set-Item "function:global:__cialai_user_$agent" $existing.ScriptBlock
  }
}
Remove-Variable agent, existing -ErrorAction SilentlyContinue
function global:codex { __CialaiAgentsRun 'codex' 'CODEX_HOME' 'CODEX_PROFILE' $args }
function global:claude { __CialaiAgentsRun 'claude' 'CLAUDE_CONFIG_DIR' 'CLAUDE_PROFILE' $args }
