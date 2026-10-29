# SPDX-License-Identifier: Apache-2.0
param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Binary,[Parameter(Mandatory=$true)][string]$OwnerSid,[string]$StateDir,[string]$OwnerHome,[switch]$PlanOnly,[switch]$ValidateOnly,[switch]$LoadTypesOnly,[switch]$Elevated)
$ErrorActionPreference='Stop'
if ($OwnerSid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'A normal local or domain account is required.' }
if (-not ('BrotoAccount' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
public static class BrotoAccount {
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public uint Length; public IntPtr RootDirectory,ObjectName; public uint Flags; public IntPtr Descriptor,Quality; }
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length,MaximumLength; public IntPtr Buffer; }
 [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system,ref Attributes attributes,uint access,out IntPtr handle);
 [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle,byte[] sid,Unicode[] rights,uint count);
 [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
 [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUser(string user,string domain,IntPtr password,int type,int provider,out IntPtr token);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static void GrantRight(SecurityIdentifier sid,string name) {
  if(name!="SeServiceLogonRight" && name!="SeBatchLogonRight")throw new ArgumentException("Unsupported Broto account right.");
  Attributes attributes=new Attributes(); attributes.Length=(uint)Marshal.SizeOf(typeof(Attributes)); IntPtr policy;
  uint status=LsaOpenPolicy(IntPtr.Zero,ref attributes,0x810,out policy); if(status!=0)throw new Win32Exception((int)LsaNtStatusToWinError(status));
  Unicode right=new Unicode();right.Buffer=Marshal.StringToHGlobalUni(name);right.Length=(ushort)(name.Length*2);right.MaximumLength=(ushort)(right.Length+2);
  try { byte[] bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);status=LsaAddAccountRights(policy,bytes,new Unicode[]{right},1);if(status!=0)throw new Win32Exception((int)LsaNtStatusToWinError(status)); }
  finally {Marshal.FreeHGlobal(right.Buffer);LsaClose(policy);}
 }
 // The interactive logon proves the password before the account receives a logon right.
 // The service logon runs afterwards because it needs the right it is testing. An
 // administrator account is accepted: its service logon gets the full token.
 public static void Prepare(string account,SecurityIdentifier sid,SecureString password) {
  Check(account,password,2);
  GrantRight(sid,"SeServiceLogonRight");GrantRight(sid,"SeBatchLogonRight");
  Check(account,password,5);
 }
 static void Check(string account,SecureString password,int type) {
  string domain=".";string name=account;int split=account.IndexOf('\\');if(split>=0){domain=account.Substring(0,split);name=account.Substring(split+1);}else if(account.Contains("@")){domain=null;}IntPtr raw=Marshal.SecureStringToGlobalAllocUnicode(password);IntPtr token=IntPtr.Zero;
  try {if(!LogonUser(name,domain,raw,type,0,out token))throw new Win32Exception(Marshal.GetLastWin32Error());}
  finally {if(token!=IntPtr.Zero)CloseHandle(token);Marshal.ZeroFreeGlobalAllocUnicode(raw);}
 }
}
'@
}
if ($LoadTypesOnly) { return }
if ($ValidateOnly) { Write-Output 'Broto installer types validated'; exit 0 }
if ($PlanOnly) { @{service='CialaiBroto';binary=$Binary;owner=$OwnerSid;updateHours=6;passwordTransport='Windows credential UI'} | ConvertTo-Json -Compress; exit 0 }
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
$credential=Get-Credential -UserName $account -Message 'Cialai Broto runs the service and its updates with this account and all of its permissions.'
if ($null -eq $credential) { throw 'Installation cancelled.' }
$chosen=([Security.Principal.NTAccount]::new($credential.UserName)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($chosen -ne $OwnerSid) { throw 'Use the same account as the Broto window.' }

[BrotoAccount]::Prepare($credential.UserName,[Security.Principal.SecurityIdentifier]::new($OwnerSid),$credential.Password)
$path='"'+$Binary+'" service --install-root "'+$Root+'" --state-dir "'+$StateDir+'"'
$existing=Get-CimInstance Win32_Service -Filter "Name='CialaiBroto'" -ErrorAction SilentlyContinue
if ($null -eq $existing) { New-Service -Name CialaiBroto -BinaryPathName $path -DisplayName 'Cialai Broto' -StartupType Automatic -Credential $credential | Out-Null }
elseif ($existing.PathName -ne $path) { throw 'A different Broto service already exists.' }
elseif ($existing) { $existingAccount=$existing.StartName; if($existingAccount.StartsWith('.\')){$existingAccount=$env:COMPUTERNAME+'\'+$existingAccount.Substring(2)};if(([Security.Principal.NTAccount]::new($existingAccount)).Translate([Security.Principal.SecurityIdentifier]).Value -ne $OwnerSid){throw 'A different service account is configured.'} }
if ($existing) {
 # Refresh only the already-validated account password, inside the elevated installer.
 # This never delegates configuration rights to the service or puts a password in argv.
 $changed=Invoke-CimMethod -InputObject $existing -MethodName Change -Arguments @{StartPassword=$credential.GetNetworkCredential().Password}
 if ($changed.ReturnValue -ne 0) { throw 'Could not update the existing Broto service credential.' }
}
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\CialaiBroto' -Name Environment -PropertyType MultiString -Value @(('USERPROFILE='+$OwnerHome),('APPDATA='+(Split-Path $StateDir -Parent)),('LOCALAPPDATA='+(Join-Path $OwnerHome 'AppData\Local')),('USERNAME='+($account -split '\\')[-1]),('USERDOMAIN='+($account -split '\\')[0])) -Force | Out-Null
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
# The password stays inside this process and Windows Task Scheduler storage, never argv or a file.
Register-ScheduledTask -TaskName ('CialaiBrotoUpdate-'+$OwnerSid) -Action $action -Trigger $trigger -Settings $settings -User $credential.UserName -Password ($credential.GetNetworkCredential().Password) -RunLevel Limited -Force | Out-Null
$credential=$null
Start-Service CialaiBroto
(Get-Service CialaiBroto).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
