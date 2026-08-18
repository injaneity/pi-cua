$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
if (-not (Test-Path $git)) {
  $release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'cua-pi-bootstrap' } -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest'
  $asset = $release.assets | Where-Object { $_.name -match '^Git-[0-9].*-64-bit\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw 'No Git for Windows installer found' }
  $installer = 'C:\Windows\Temp\cua-git.exe'
  Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $installer
  $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Git installer exited $($process.ExitCode)" }
  Remove-Item -Force $installer
}
Add-MachinePath 'C:\Program Files\Git\cmd'
$nodeRoot = 'C:\cua\node-v22.20.0-win-x64'
$node = "$nodeRoot\node.exe"
$npm = "$nodeRoot\npm.cmd"
$nodeVersion = if (Test-Path $node) { (& $node --version) } else { '' }
if ($nodeVersion -ne 'v22.20.0') {
  $nodeZip = 'C:\Windows\Temp\cua-node-v22.20.0-win-x64.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip' -OutFile $nodeZip
  if ((Get-FileHash -Algorithm SHA256 $nodeZip).Hash.ToLowerInvariant() -ne 'bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d') { throw 'Node.js archive digest mismatch' }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $nodeRoot
  Expand-Archive -Force -Path $nodeZip -DestinationPath 'C:\cua'
  Remove-Item -Force $nodeZip
}
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
if ($piVersion -ne '__PI_VERSION__') {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$npmPrefix\node_modules\@earendil-works\pi-coding-agent"
  $npmStdout = 'C:\Windows\Temp\cua-npm.stdout.log'
  $npmStderr = 'C:\Windows\Temp\cua-npm.stderr.log'
  $npmProcess = Start-Process -FilePath $npm -ArgumentList 'install','-g','--ignore-scripts','@earendil-works/pi-coding-agent@__PI_VERSION__' -Wait -PassThru -NoNewWindow -RedirectStandardOutput $npmStdout -RedirectStandardError $npmStderr
  Get-Content -ErrorAction SilentlyContinue $npmStdout
  Get-Content -ErrorAction SilentlyContinue $npmStderr
  Remove-Item -Force -ErrorAction SilentlyContinue $npmStdout,$npmStderr
  if ($npmProcess.ExitCode -ne 0) { throw "Pi npm installation failed with exit $($npmProcess.ExitCode)" }
}
Write-Output '::phase npm-complete'
Add-MachinePath $npmPrefix
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $tailscale)) {
  $msi = 'C:\Windows\Temp\cua-tailscale.msi'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi
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
$extensions = "$agent\extensions"
$projects = 'C:\cua\projects'
$sshDirectory = 'C:\ProgramData\ssh'
$authorizedKeys = "$sshDirectory\cua_authorized_keys"
Remove-Item -Force -ErrorAction SilentlyContinue "$agent\auth.json","$agent\models.json","$agent\APPEND_SYSTEM.md"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $extensions,"$agent\prompt-templates","$agent\skills"
New-Item -ItemType Directory -Force -Path $agent,$extensions,$projects,$sshDirectory | Out-Null
Expand-Archive -Force -Path 'C:\Windows\Temp\cua-pi-agent.zip' -DestinationPath $cuaHome
Copy-Item -Force 'C:\Windows\Temp\cua-authorized-key.pub' $authorizedKeys
Invoke-Icacls @($cuaHome, '/grant:r', 'cua:(OI)(CI)F', '/T', '/C')
Invoke-Icacls @($projects, '/grant:r', 'cua:(OI)(CI)F', '/T', '/C')
Invoke-Icacls @($authorizedKeys, '/inheritance:r', '/grant:r', 'cua:F', 'SYSTEM:F', 'Administrators:F')
Write-Output '::phase acl-complete'
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name 'DefaultShell' -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
$sshdConfig = @'
Port 22
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AuthorizedKeysFile C:/ProgramData/ssh/cua_authorized_keys
Subsystem sftp sftp-server.exe
AllowUsers cua
'@
Set-Content -Encoding ascii -Path 'C:\ProgramData\ssh\sshd_config' -Value $sshdConfig
Set-Service -Name sshd -StartupType Automatic
Restart-Service -Name sshd
Write-Output '::phase sshd-ready'
if (-not (Get-NetFirewallRule -Name 'CUA-OpenSSH-Tailnet' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'CUA-OpenSSH-Tailnet' -DisplayName 'CUA OpenSSH over Tailscale' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress '100.64.0.0/10' | Out-Null
}
$tailscaleAuthKey = (Get-Content -Raw 'C:\Windows\Temp\cua-tailscale-auth-key').Trim()
& $tailscale up --reset "--auth-key=$tailscaleAuthKey" '--advertise-tags=tag:cua-sandbox' '--hostname=__HOSTNAME__'
if ($LASTEXITCODE -ne 0) { throw 'tailscale up failed' }
Write-Output '::phase tailscale-up'
$tailscaleAuthKey = $null
New-Item -ItemType Directory -Force -Path 'C:\ProgramData\cua-pi' | Out-Null
Set-Content -Encoding ascii -Path 'C:\ProgramData\cua-pi\bootstrap-version' -Value '__BOOTSTRAP_VERSION__'
Remove-Item -Force -ErrorAction SilentlyContinue 'C:\Windows\Temp\cua-pi-agent.zip','C:\Windows\Temp\cua-authorized-key.pub','C:\Windows\Temp\cua-tailscale-auth-key','C:\Windows\Temp\cua-bootstrap.ps1'
& $tailscale ip -4 | Select-Object -First 1
