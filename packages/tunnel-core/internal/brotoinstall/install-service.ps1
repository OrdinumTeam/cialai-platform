# SPDX-License-Identifier: Apache-2.0
param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Binary,[Parameter(Mandatory=$true)][string]$OwnerSid,[string]$StateDir,[string]$OwnerHome,[switch]$PlanOnly,[switch]$ValidateOnly,[switch]$Elevated)
$ErrorActionPreference='Stop'
if ($OwnerSid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'A normal local or domain account is required.' }
if ($ValidateOnly) { Write-Output 'Broto installer validated'; exit 0 }
if ($PlanOnly) { @{service='CialaiBroto';binary=$Binary;owner=$OwnerSid;updateHours=6;account='LocalSystem'} | ConvertTo-Json -Compress; exit 0 }
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # With UAC off, RunAs starts the same unprivileged token again; relaunching
  # from there would spawn installers until the session runs out of memory.
  if ($Elevated) { throw 'Windows did not elevate the Broto installer. Turn on User Account Control or run it from an administrator.' }
  function Quote([string]$value) { if ($value.Contains('"') -or $value.Contains("`n")) { throw 'Invalid installation path.' }; return '"'+$value+'"' }
  $arguments='-NoProfile -ExecutionPolicy Bypass -File '+(Quote $PSCommandPath)+' -Root '+(Quote $Root)+' -Binary '+(Quote $Binary)+' -OwnerSid '+(Quote $OwnerSid)+' -StateDir '+(Quote $StateDir)+' -OwnerHome '+(Quote $OwnerHome)+' -Elevated'
  $process=Start-Process (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $arguments
  exit $process.ExitCode
}
Import-Module (Join-Path $PSHOME 'Modules\ScheduledTasks\ScheduledTasks.psd1') -Force
$systemDirectory=[IO.Path]::GetFullPath((Join-Path $PSHOME '..\..'))
$serviceController=Join-Path $systemDirectory 'sc.exe'
$account=([Security.Principal.SecurityIdentifier]::new($OwnerSid)).Translate([Security.Principal.NTAccount]).Value
# The service and its updates run as LocalSystem, so no password is asked.
# The owner comes from the Broto window and only sets which account the
# service works for: its pipes, its state and its environment.
$path='"'+$Binary+'" service --install-root "'+$Root+'" --state-dir "'+$StateDir+'"'
$existing=Get-CimInstance Win32_Service -Filter "Name='CialaiBroto'" -ErrorAction SilentlyContinue
if ($null -eq $existing) { New-Service -Name CialaiBroto -BinaryPathName $path -DisplayName 'Cialai Broto' -StartupType Automatic | Out-Null }
elseif ($existing.PathName -ne $path) { throw 'A different Broto service already exists.' }
elseif ($existing.StartName -ne 'LocalSystem') {
 # Broto 0.1.2 ran the service with the account password. Move it to LocalSystem.
 $changed=Invoke-CimMethod -InputObject $existing -MethodName Change -Arguments @{StartName='LocalSystem';StartPassword=''}
 if ($changed.ReturnValue -ne 0) { throw 'Could not move the Broto service to LocalSystem.' }
 Stop-Service CialaiBroto -Force -ErrorAction SilentlyContinue
}
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\CialaiBroto' -Name Environment -PropertyType MultiString -Value @(('USERPROFILE='+$OwnerHome),('APPDATA='+(Split-Path $StateDir -Parent)),('LOCALAPPDATA='+(Join-Path $OwnerHome 'AppData\Local')),('USERNAME='+($account -split '\\')[-1]),('USERDOMAIN='+($account -split '\\')[0]),('CIALAI_BROTO_OWNER_SID='+$OwnerSid)) -Force | Out-Null
# The account may query, start and stop its own service, but cannot change its account or ImagePath.
& $serviceController sdset CialaiBroto "D:(A;;CCLCSWRPWPDTLOCRRC;;;$OwnerSid)(A;;GA;;;SY)(A;;GA;;;BA)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not delegate Broto service control.' }
& $serviceController failure CialaiBroto reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not configure Broto service recovery.' }
& $serviceController failureflag CialaiBroto 1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not configure Broto service failure handling.' }
$action=New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $Root 'run-update.ps1')+'"')
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 6)
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 11)
$updater=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName ('CialaiBrotoUpdate-'+$OwnerSid) -Action $action -Trigger $trigger -Settings $settings -Principal $updater -Force | Out-Null
Start-Service CialaiBroto
(Get-Service CialaiBroto).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
