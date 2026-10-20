import { runProcess, type SpaceItem, type SpacesClient } from "./spaces.ts";
import type { Probe, Remote } from "./remote.ts";

const discovery = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
  $root = Split-Path $git -Parent
  $bash = $null
  for ($i = 0; $i -lt 3 -and $root; $i++) {
    $candidate = Join-Path $root 'bin\bash.exe'
    if (Test-Path -LiteralPath $candidate) { $bash = $candidate; break }
    $root = Split-Path $root -Parent
  }
  if (!$bash) { throw 'Git for Windows Bash was not found beside git.exe' }
  $homePath = [Environment]::GetFolderPath('UserProfile')
  if (!$homePath -or $homePath.StartsWith('\\')) { throw 'A local Windows user profile is required' }
  $state = Join-Path $homePath '.cua-pi'
  [void][IO.Directory]::CreateDirectory($state)
  $identity = Join-Path $state 'machine-id'
  try {
    $file = [IO.File]::Open($identity, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes([Guid]::NewGuid().ToString())
      $file.Write($bytes, 0, $bytes.Length)
    } finally { $file.Dispose() }
  } catch [IO.IOException] {
    if (!(Test-Path -LiteralPath $identity)) { throw }
  }
  $installation = [IO.File]::ReadAllText($identity).Trim()
  if (!$installation) { throw 'The pi-cua machine identity is empty' }
  $machine = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
  if (!$machine) { throw 'Windows MachineGuid is unavailable' }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($homePath))
  @{
    home = $homePath.Replace('\', '/')
    shell = $bash.Replace('\', '/')
    nodeDirectory = (Split-Path $node -Parent).Replace('\', '/')
    machineId = "$machine/$installation"
    freeBytes = $drive.AvailableFreeSpace
  } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export async function probeWindows(client: SpacesClient, space: SpaceItem, signal?: AbortSignal): Promise<{ remote: Remote; probe: Probe }> {
  const result = await runProcess(client, space.id, {
    program: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(discovery, "utf16le").toString("base64")],
    timeoutMs: 30_000,
  }, undefined, signal);
  if (result.code !== 0 || result.timedOut)
    throw new Error(`Windows prerequisite check on ${space.name} failed: ${(result.stderr || result.error || "no response").trim().slice(-2000)}. Install Node.js 22+ and Git for Windows for the spacesd user, then restart spacesd so its PATH includes node.exe and git.exe.`);
  const value = JSON.parse(result.stdout.toString("utf8").replace(/^\uFEFF/, ""));
  const absolute = (path: unknown): path is string => typeof path === "string" && /^[a-z]:\//i.test(path);
  if (!absolute(value.home) || !absolute(value.shell) || !absolute(value.nodeDirectory) || typeof value.machineId !== "string" || !Number.isSafeInteger(value.freeBytes) || value.freeBytes < 0)
    throw new Error(`Invalid Windows prerequisite response from ${space.name}`);
  return {
    remote: { client, spaceId: space.id, name: space.name, os: "windows", home: value.home, shell: value.shell, nodeDirectory: value.nodeDirectory },
    probe: { home: value.home, machineId: value.machineId, freeBytes: value.freeBytes },
  };
}
