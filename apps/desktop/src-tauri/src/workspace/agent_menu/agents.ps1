# SPDX-License-Identifier: Apache-2.0
# Cialai: menu de contas ao digitar codex ou claude nas sessoes do Cialai.
# O app passa este script ao PowerShell por -EncodedCommand, que roda depois
# do perfil do usuario e nao depende da politica de execucao. Mesmo contrato
# de agents.zsh: contas em ~/.cialai/agents/<agente>.tsv e `codex +nome`.

$global:CialaiAgentsDir = if ($env:CIALAI_AGENTS_DIR) { $env:CIALAI_AGENTS_DIR } else { Join-Path $(if ($HOME) { $HOME } else { $env:USERPROFILE }) '.cialai/agents' }

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
    $text = switch ($Key) { 'question' { '?' } 'enter' { '↑ ↓, Enter: {name}' } default { '{name}?' } }
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

# Escreve um trecho com cor e devolve quantas colunas ele ocupou.
function global:__CialaiAgentsPut([string]$Text, $Color) {
  if ($Color) { [Console]::ForegroundColor = $Color }
  [Console]::Write($Text)
  if ($Color) { [Console]::ResetColor() }
  return $Text.Length
}

# Desenha as contas e a dica, com a escolhida em destaque, e termina na linha
# da dica. No Windows cada linha e completada com espacos ate a largura da
# janela, para o redesenho por posicao apagar o que sobrou; nos outros
# sistemas quem apaga e a sequencia ANSI.
function global:__CialaiAgentsDraw([object[]]$Rows, [int]$Choice, [int]$Width, [bool]$Ansi) {
  $esc = [char]27
  $full = 0
  if (-not $Ansi) { try { $full = [Console]::WindowWidth - 1 } catch { $full = 0 } }
  for ($index = 0; $index -lt $Rows.Count; $index++) {
    $row = $Rows[$index]
    $on = $index -eq $Choice
    if ($Ansi) { [Console]::Write("$esc[2K") }
    $used = 0
    $used += __CialaiAgentsPut $(if ($on) { "$([char]0x203A) " } else { '  ' }) $(if ($on) { 'Magenta' } else { $null })
    $used += __CialaiAgentsPut "$($index + 1)  " 'DarkGray'
    $used += __CialaiAgentsPut ($row.Label.PadRight($Width) + '  ') $(if ($on) { 'Magenta' } else { $null })
    $tone = switch ($row.State) { 'out' { 'Red' } 'free' { 'Green' } default { 'DarkGray' } }
    $used += __CialaiAgentsPut ($row.Value + '  ') $tone
    $used += __CialaiAgentsPut $row.Detail 'DarkGray'
    if ($full -gt $used) { [Console]::Write(' ' * ($full - $used)) }
    [Console]::WriteLine()
  }
  if ($Ansi) { [Console]::Write("$esc[2K") }
  $used = __CialaiAgentsPut (__CialaiAgentsText 'enter' $Rows[$Choice].Label) 'DarkGray'
  if ($full -gt $used) { [Console]::Write(' ' * ($full - $used)) }
}

# Uma tecla vira up, down, enter, cancel, um numero de 1 a 9 ou vazio.
function global:__CialaiAgentsKey {
  $key = [Console]::ReadKey($true)
  $char = [string]$key.KeyChar
  if ($key.Key -eq [ConsoleKey]::UpArrow) { return 'up' }
  if ($key.Key -eq [ConsoleKey]::DownArrow) { return 'down' }
  if ($key.Key -eq [ConsoleKey]::Enter) { return 'enter' }
  if ($key.Key -eq [ConsoleKey]::Escape) { return 'cancel' }
  if (($key.Modifiers -band [ConsoleModifiers]::Control) -and ($key.Key -eq [ConsoleKey]::C -or $key.Key -eq [ConsoleKey]::D)) { return 'cancel' }
  if ($char -ceq 'k') { return 'up' }
  if ($char -ceq 'j') { return 'down' }
  if ($char -ceq 'q') { return 'cancel' }
  if ($char -match '^[1-9]$') { return $char }
  return ''
}

# Devolve a conta escolhida ou 'skip', 'missing' e 'cancel'. A conta se
# escolhe com as setas, ou com j e k, e Enter abre; um numero de 1 a 9 abre a
# conta dele direto, e Esc, q ou Ctrl+C desistem.
function global:__CialaiAgentsPick([string]$Agent, [string]$Wanted) {
  $rows = __CialaiAgentsRows $Agent
  if ($Wanted) {
    foreach ($row in $rows) { if ($row.Name -eq $Wanted -or $row.Label -eq $Wanted) { return $row } }
    return 'missing'
  }
  if ($rows.Count -lt 2) { return 'skip' }

  # Comeca na ultima conta usada nesta pasta, ou na seguinte com cota.
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

  # No Windows o console desenha por posicao e cor, que valem no PowerShell 5.1
  # e no 7; no resto, por ANSI. Durante o menu a saida fica em UTF-8, para a
  # seta e os acentos dos rotulos aparecerem certos, e o Ctrl+C vira tecla.
  $ansi = -not ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows)
  $esc = [char]27
  $width = ($rows | ForEach-Object { $_.Label.Length } | Measure-Object -Maximum).Maximum
  $encoding = $null
  $control = $false
  try {
    if (-not $ansi) {
      try { $encoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { $encoding = $null }
    }
    try { $control = [Console]::TreatControlCAsInput; [Console]::TreatControlCAsInput = $true } catch { }
    if ($ansi) { [Console]::Write("$esc[1m$(__CialaiAgentsText 'question' '')$esc[0m") } else { $null = __CialaiAgentsPut (__CialaiAgentsText 'question' '') 'White' }
    [Console]::WriteLine()
    __CialaiAgentsDraw $rows $choice $width $ansi
    $top = 0
    if (-not $ansi) { $top = [Console]::CursorTop - $rows.Count }
    while ($true) {
      $action = __CialaiAgentsKey
      switch -regex ($action) {
        '^enter$' { break }
        '^cancel$' { break }
        '^up$' { $choice = if ($choice -gt 0) { $choice - 1 } else { $rows.Count - 1 } }
        '^down$' { $choice = if ($choice -lt $rows.Count - 1) { $choice + 1 } else { 0 } }
        '^[1-9]$' { if ([int]$action -le $rows.Count) { $choice = [int]$action - 1 } else { $action = '' } }
      }
      if ($action -eq 'enter' -or $action -eq 'cancel') { break }
      if (-not $action) { continue }
      if ($ansi) { [Console]::Write("`r$esc[$($rows.Count)A") } else { [Console]::SetCursorPosition(0, $top) }
      __CialaiAgentsDraw $rows $choice $width $ansi
      if ($action -match '^[1-9]$') { break }
    }
    [Console]::WriteLine()
    if ($action -eq 'cancel') { return 'cancel' }
    return $rows[$choice]
  } finally {
    [Console]::ResetColor()
    try { [Console]::TreatControlCAsInput = $control } catch { }
    if ($encoding) { try { [Console]::OutputEncoding = $encoding } catch { } }
  }
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
  } elseif ([Environment]::GetEnvironmentVariable($DirKey) -or $env:CIALAI_AGENT_MENU -eq '0' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or (__CialaiAgentsSkip $Agent $Rest)) {
    __CialaiAgentsCall $Agent $Rest
    return
  }
  $pick = __CialaiAgentsPick $Agent $wanted
  if ($pick -is [string]) {
    switch ($pick) {
      'skip' { __CialaiAgentsCall $Agent $Rest }
      'missing' { [Console]::Error.WriteLine((__CialaiAgentsText 'missing' $wanted)); $global:LASTEXITCODE = 2 }
      default { $global:LASTEXITCODE = 130 }
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
