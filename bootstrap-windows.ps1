$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$reliabilityPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Reliability'
New-Item -Path $reliabilityPolicy -Force | Out-Null
New-ItemProperty -Path $reliabilityPolicy -Name ShutdownReasonOn -Value 0 -PropertyType DWord -Force | Out-Null
function Add-MachinePath([string]$PathToAdd) {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($machinePath -split ';') -notcontains $PathToAdd) {
    [Environment]::SetEnvironmentVariable('Path', ($machinePath.TrimEnd(';') + ';' + $PathToAdd), 'Machine')
  }
  if (($env:Path -split ';') -notcontains $PathToAdd) { $env:Path = $env:Path.TrimEnd(';') + ';' + $PathToAdd }
}
function Invoke-Icacls([string[]]$Arguments) {
  $stdout = 'C:\Windows\Temp\cua-icacls.stdout.log'
  $stderr = 'C:\Windows\Temp\cua-icacls.stderr.log'
  $process = Start-Process -FilePath 'icacls.exe' -ArgumentList $Arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if ($process.ExitCode -ne 0) {
    $detail = ((Get-Content -ErrorAction SilentlyContinue $stdout), (Get-Content -ErrorAction SilentlyContinue $stderr)) -join "`n"
    throw "icacls failed with exit $($process.ExitCode): $detail"
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $stdout,$stderr
}
$git = 'C:\Program Files\Git\cmd\git.exe'
$gitVersion = if (Test-Path $git) { (& $git --version) } else { '' }
if ($gitVersion -notlike 'git version 2.55.0.windows.*') {
  $installer = 'C:\Windows\Temp\cua-git.exe'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe' -OutFile $installer
  if ((Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant() -ne 'd065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6') { throw 'Git installer digest mismatch' }
  $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Git installer exited $($process.ExitCode)" }
  Remove-Item -Force $installer
}
Add-MachinePath 'C:\Program Files\Git\cmd'
$nodeRoot = 'C:\cua\node'
$node = "$nodeRoot\node.exe"
$npm = "$nodeRoot\npm.cmd"
$nodeVersion = if (Test-Path $node) { (& $node --version) } else { '' }
if ($nodeVersion -ne 'v22.20.0') {
  $nodeZip = 'C:\Windows\Temp\cua-node-v22.20.0-win-x64.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip' -OutFile $nodeZip
  if ((Get-FileHash -Algorithm SHA256 $nodeZip).Hash.ToLowerInvariant() -ne 'bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d') { throw 'Node.js archive digest mismatch' }
  $nodeExtract = 'C:\Windows\Temp\cua-node-extract'
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $nodeRoot,$nodeExtract
  Expand-Archive -Force -Path $nodeZip -DestinationPath $nodeExtract
  New-Item -ItemType Directory -Force -Path 'C:\cua' | Out-Null
  Move-Item -Force "$nodeExtract\node-v22.20.0-win-x64" $nodeRoot
  Remove-Item -Recurse -Force $nodeExtract
  Remove-Item -Force $nodeZip
}
Invoke-Icacls @($nodeRoot, '/grant:r', '*S-1-5-32-545:(OI)(CI)RX', '/T', '/C')
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$machineParts = @($machinePath -split ';' | Where-Object { $_ -and $_ -ne $nodeRoot })
[Environment]::SetEnvironmentVariable('Path', ($nodeRoot + ';' + ($machineParts -join ';')), 'Machine')
$envParts = @($env:Path -split ';' | Where-Object { $_ -and $_ -ne $nodeRoot })
$env:Path = $nodeRoot + ';' + ($envParts -join ';')
$npmPrefix = 'C:\ProgramData\npm'
New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null
& $npm config set prefix $npmPrefix
$piPackage = "$npmPrefix\node_modules\@earendil-works\pi-coding-agent\package.json"
$piVersion = if (Test-Path $piPackage) { (Get-Content -Raw $piPackage | ConvertFrom-Json).version } else { '' }
$serverPackage = "$npmPrefix\node_modules\@earendil-works\pi-server\package.json"
$serverVersion = if (Test-Path $serverPackage) { (Get-Content -Raw $serverPackage | ConvertFrom-Json).version } else { '' }
if ($piVersion -ne '__PI_VERSION__' -or $serverVersion -ne '__PI_VERSION__') {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$npmPrefix\node_modules\@earendil-works\pi-coding-agent"
  $npmStdout = 'C:\Windows\Temp\cua-npm.stdout.log'
  $npmStderr = 'C:\Windows\Temp\cua-npm.stderr.log'
  $npmProcess = Start-Process -FilePath $npm -ArgumentList 'install','-g','--ignore-scripts','@earendil-works/pi-coding-agent@__PI_VERSION__','@earendil-works/pi-server@__PI_VERSION__' -Wait -PassThru -NoNewWindow -RedirectStandardOutput $npmStdout -RedirectStandardError $npmStderr
  Get-Content -ErrorAction SilentlyContinue $npmStdout
  Get-Content -ErrorAction SilentlyContinue $npmStderr
  Remove-Item -Force -ErrorAction SilentlyContinue $npmStdout,$npmStderr
  if ($npmProcess.ExitCode -ne 0) { throw "Pi npm installation failed with exit $($npmProcess.ExitCode)" }
}
'await import("file:///C:/ProgramData/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js")' | & "$nodeRoot\node.exe" --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Pi SDK import failed' }
Write-Output '::phase npm-complete'
Add-MachinePath $npmPrefix
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$tailscaleVersion = if (Test-Path $tailscale) { (& $tailscale version | Select-Object -First 1) } else { '' }
if ($tailscaleVersion -ne '1.102.3') {
  $msi = 'C:\Windows\Temp\cua-tailscale.msi'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-1.102.3-amd64.msi' -OutFile $msi
  if ((Get-FileHash -Algorithm SHA256 $msi).Hash.ToLowerInvariant() -ne '03ac8183c6e3ce276e9b44281ebe7e4c02aef28a971034ca170c4b665df42dce') { throw 'Tailscale installer digest mismatch' }
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i',"`"$msi`"",'/qn','/norestart' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Tailscale installer exited $($process.ExitCode)" }
  Remove-Item -Force $msi
}
$sshd = Get-WindowsCapability -Online | Where-Object Name -Like 'OpenSSH.Server*' | Select-Object -First 1
if (-not $sshd -or $sshd.State -ne 'Installed') { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null }
Write-Output '::phase openssh-ready'
if (-not (Get-LocalUser -Name 'cua' -ErrorAction SilentlyContinue)) {
  $password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + 'aA1!') -AsPlainText -Force
  New-LocalUser -Name 'cua' -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'CUA Pi worker' | Out-Null
}
$cuaUser = Get-LocalUser -Name 'cua'
$profile = Get-CimInstance Win32_UserProfile | Where-Object SID -EQ $cuaUser.SID.Value | Select-Object -First 1
if (-not $profile) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CuaUserEnv {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int CreateProfile(string sid, string username, StringBuilder path, uint pathLength);
}
'@
  $profilePath = New-Object System.Text.StringBuilder 260
  $result = [CuaUserEnv]::CreateProfile($cuaUser.SID.Value, 'cua', $profilePath, $profilePath.Capacity)
  if ($result -ne 0) { throw "CreateProfile failed with HRESULT $result" }
  $cuaHome = $profilePath.ToString()
} else { $cuaHome = $profile.LocalPath }
$agent = "$cuaHome\.pi\agent"
$projects = 'C:\cua\projects'
$sshDirectory = 'C:\ProgramData\ssh'
$authorizedKeys = "$sshDirectory\cua_authorized_keys"
Remove-Item -Force -ErrorAction SilentlyContinue "$agent\auth.json","$agent\models.json","$agent\APPEND_SYSTEM.md"
New-Item -ItemType Directory -Force -Path $agent,$projects,$sshDirectory | Out-Null
Expand-Archive -Force -Path 'C:\Windows\Temp\cua-pi-agent.zip' -DestinationPath $cuaHome
Copy-Item -Force 'C:\Windows\Temp\cua-authorized-key.pub' $authorizedKeys
# The SYSTEM bootstrap owns only the desktop broker. Mutable host files and
# extensions are synchronized later as cua.
Invoke-Icacls @("$agent\cua-tool-broker.mjs", '/grant:r', 'cua:F')
Invoke-Icacls @($projects, '/grant:r', 'cua:(OI)(CI)F')
Invoke-Icacls @($authorizedKeys, '/inheritance:r', '/grant:r', 'cua:F', 'SYSTEM:F', 'Administrators:F')
Write-Output '::phase acl-complete'
$interactiveDesktop = Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object SessionId -GT 0 | Select-Object -First 1
$interactiveUser = $interactiveDesktop.UserName
if (-not $interactiveUser) { throw 'CuaPiDesktopToolBroker requires an interactive Windows desktop login; log in as the desktop user, rerun cua_sandbox with {"action":"ensure","name":"__HOSTNAME__"}, then run /reload' }
$brokerTask = 'CuaPiDesktopToolBroker'
function Test-BrokerPort {
  try { $client = [Net.Sockets.TcpClient]::new('127.0.0.1', 43121); $client.Dispose(); return $true } catch { return $false }
}
Stop-ScheduledTask -TaskName $brokerTask -ErrorAction SilentlyContinue
for ($attempt = 0; $attempt -lt 50 -and (Test-BrokerPort); $attempt++) { Start-Sleep -Milliseconds 200 }
if ($attempt -eq 50) { throw 'CuaPiDesktopToolBroker did not release 127.0.0.1:43121; stop the process or restart Windows, rerun cua_sandbox with {"action":"ensure","name":"__HOSTNAME__"}, then run /reload' }
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'C:\cua\node-v22.20.0-win-x64'
Remove-Item -Force -ErrorAction SilentlyContinue 'C:\ProgramData\cua-pi\start-desktop-tool-broker.vbs',"$agent\cua-tool-broker.token","$agent\cua-tool-relay.mjs"
Unregister-ScheduledTask -TaskName $brokerTask -Confirm:$false -ErrorAction SilentlyContinue
$brokerAction = New-ScheduledTaskAction -Execute $node -Argument "`"$agent\cua-tool-broker.mjs`""
$brokerTrigger = New-ScheduledTaskTrigger -AtLogOn -User $interactiveUser
$brokerPrincipal = New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Highest
$brokerSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $brokerTask -Action $brokerAction -Trigger $brokerTrigger -Principal $brokerPrincipal -Settings $brokerSettings | Out-Null
$brokerReady = $false
for ($startAttempt = 0; $startAttempt -lt 3 -and -not $brokerReady; $startAttempt++) {
  Start-ScheduledTask -TaskName $brokerTask
  for ($attempt = 0; $attempt -lt 50 -and -not (Test-BrokerPort); $attempt++) { Start-Sleep -Milliseconds 200 }
  if (Test-BrokerPort) {
    Start-Sleep -Seconds 1
    $brokerReady = (Test-BrokerPort) -and (Get-ScheduledTask -TaskName $brokerTask).State -eq 'Running'
  }
}
if (-not $brokerReady) { throw 'CuaPiDesktopToolBroker did not remain listening on 127.0.0.1:43121; run Start-ScheduledTask -TaskName CuaPiDesktopToolBroker in elevated PowerShell, or rerun cua_sandbox with {"action":"ensure","name":"__HOSTNAME__"}, then run /reload' }
Write-Output '::phase desktop-broker-ready'
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name 'DefaultShell' -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
$sshdConfig = @'
Port 22
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AllowTcpForwarding local
PermitOpen 127.0.0.1:43121
AuthorizedKeysFile C:/ProgramData/ssh/cua_authorized_keys
Subsystem sftp sftp-server.exe
AllowUsers cua
'@
Set-Content -Encoding ascii -Path 'C:\ProgramData\ssh\sshd_config' -Value $sshdConfig
Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
Remove-Item -Force -ErrorAction SilentlyContinue 'C:\ProgramData\ssh\ssh_host_*'
$hostKey = 'C:\ProgramData\ssh\ssh_host_ed25519_key'
& "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe" -q -t ed25519 -N '""' -f $hostKey
if ($LASTEXITCODE -ne 0) { throw 'OpenSSH host key generation failed' }
$bootstrapSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Invoke-Icacls @($hostKey, '/setowner', '*S-1-5-18')
Invoke-Icacls @($hostKey, '/inheritance:r', '/grant:r', 'SYSTEM:F', 'Administrators:F', '/remove:g', "*$bootstrapSid")
Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd
Write-Output '::phase sshd-ready'
if (-not (Get-NetFirewallRule -Name 'CUA-OpenSSH-Tailnet' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'CUA-OpenSSH-Tailnet' -DisplayName 'CUA OpenSSH over Tailscale' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress '100.64.0.0/10' | Out-Null
}
$tailscaleAuthKey = (Get-Content -Raw 'C:\Windows\Temp\cua-tailscale-auth-key').Trim()
& $tailscale up --reset --force-reauth "--auth-key=$tailscaleAuthKey" '--advertise-tags=tag:cua-sandbox' '--hostname=__HOSTNAME__'
if ($LASTEXITCODE -ne 0) { throw 'tailscale up failed' }
Write-Output '::phase tailscale-up'
$tailscaleAuthKey = $null
New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua-pi' | Out-Null
Set-Content -Encoding ascii -Path 'C:\ProgramData\cua-pi\bootstrap-version' -Value '__BOOTSTRAP_VERSION__'
Remove-Item -Force -ErrorAction SilentlyContinue 'C:\Windows\Temp\cua-pi-agent.zip','C:\Windows\Temp\cua-authorized-key.pub','C:\Windows\Temp\cua-tailscale-auth-key','C:\Windows\Temp\cua-bootstrap.ps1'
& $tailscale ip -4 | Select-Object -First 1
