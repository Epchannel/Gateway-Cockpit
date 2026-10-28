[CmdletBinding()]
param(
  [ValidateSet('Start','Run','Stop','Status','Install','Uninstall')][string]$Mode = 'Start',
  [string]$SecretsFile,
  [string]$DatabasePath,
  [int]$Port = 8787,
  [ValidateRange(1, 16777216)][int]$BodyLimit = 16777216
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$state = Join-Path $env:LOCALAPPDATA 'ApiHnq'
$pidFile = Join-Path $state 'supervisor.pid'; $appPidFile = Join-Path $state 'app.pid'
$log = Join-Path $state 'api-hnq.log'; $outLog = Join-Path $state 'api-hnq.out.log'; $errLog = Join-Path $state 'api-hnq.err.log'
$startupScript = Join-Path $state 'startup.ps1'; $runName = 'ApiHnqGateway'
New-Item -ItemType Directory -Force -Path $state | Out-Null

function Write-PidFile([string]$path, [System.Diagnostics.Process]$process) {
  [System.IO.File]::WriteAllText($path, (@{ pid = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))
}
function Get-PidFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $record = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
    if ($process.StartTime.ToUniversalTime().ToString('o') -ne [string]$record.started) { throw 'Stale PID identity.' }
    return $process
  } catch { Remove-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue; return $null }
}
function Claim-Supervisor {
  try {
    $stream = [System.IO.File]::Open($pidFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $record = @{ pid = $PID; started = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($record); $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    return $true
  } catch { return $false }
}
function Rotate-One([string]$path) {
  if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 5MB) {
    try {
      for ($i = 4; $i -ge 1; $i--) { $old = "$path.$i"; $new = "$path." + ($i + 1); if (Test-Path -LiteralPath $old) { Move-Item -Force -LiteralPath $old -Destination $new } }
      Move-Item -Force -LiteralPath $path -Destination "$path.1"
    } catch { return }
  }
}
function Rotate-Logs { Rotate-One $log; Rotate-One $outLog; Rotate-One $errLog }
function Write-Log([string]$message) { Rotate-Logs; Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $message" }
function Test-Health { try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/healthz").StatusCode -eq 200 } catch { return $false } }
function Quote-Argument([string]$value) { '"' + $value.Replace('"', '\"') + '"' }

if ($Mode -eq 'Status') {
  $supervisor = Get-PidFile $pidFile; $app = Get-PidFile $appPidFile
  [pscustomobject]@{ supervisorRunning = [bool]$supervisor; supervisorPid = if($supervisor){$supervisor.Id}else{$null}; appRunning = [bool]$app; appPid = if($app){$app.Id}else{$null}; healthy = if($app){Test-Health}else{$false}; log = $log } | ConvertTo-Json -Compress
  exit 0
}
if ($Mode -eq 'Stop') {
  $supervisor = Get-PidFile $pidFile; $app = Get-PidFile $appPidFile
  if ($supervisor) { Stop-Process -Id $supervisor.Id -ErrorAction SilentlyContinue }
  if ($app) { Stop-Process -Id $app.Id -ErrorAction SilentlyContinue }
  Remove-Item -Force -LiteralPath $pidFile,$appPidFile -ErrorAction SilentlyContinue; Write-Log 'Stopped by operator.'; exit 0
}
if ($Mode -eq 'Install') {
  if (-not $SecretsFile -or -not $DatabasePath) { throw 'Install requires -SecretsFile and -DatabasePath.' }
  $trampoline = '& ' + (Quote-Argument $PSCommandPath) + ' -Mode Start -SecretsFile ' + (Quote-Argument $SecretsFile) + ' -DatabasePath ' + (Quote-Argument $DatabasePath) + ' -Port ' + $Port + ' -BodyLimit ' + $BodyLimit
  Set-Content -LiteralPath $startupScript -Value $trampoline -Encoding utf8
  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote-Argument $startupScript)
  if ($command.Length -gt 260) { throw 'Startup trampoline command unexpectedly exceeds the Registry Run limit.' }
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runName -Value $command; Write-Output 'Installed current-user startup entry.'; exit 0
}
if ($Mode -eq 'Uninstall') { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runName -ErrorAction SilentlyContinue; Remove-Item -Force -LiteralPath $startupScript -ErrorAction SilentlyContinue; Write-Output 'Removed current-user startup entry.'; exit 0 }
if (-not $SecretsFile -or -not $DatabasePath) { throw 'Start/Run requires -SecretsFile and -DatabasePath.' }
if (-not (Test-Path -LiteralPath $SecretsFile)) { throw 'Secrets file does not exist.' }
if ($Mode -eq 'Start') {
  if (Get-PidFile $pidFile) { Write-Output 'Supervisor is already running.'; exit 0 }
  $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote-Argument $PSCommandPath) + ' -Mode Run -SecretsFile ' + (Quote-Argument $SecretsFile) + ' -DatabasePath ' + (Quote-Argument $DatabasePath) + ' -Port ' + $Port + ' -BodyLimit ' + $BodyLimit
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null; Write-Output 'Supervisor started.'; exit 0
}
if (-not (Claim-Supervisor)) { Write-Log 'Duplicate supervisor refused.'; exit 0 }
try {
  $node = (Get-Command node -ErrorAction Stop).Source; $delay = 1
  while ($true) {
    $env:API_HNQ_SECRETS_FILE = $SecretsFile; $env:API_HNQ_DATABASE_PATH = $DatabasePath; $env:API_HNQ_HOST = '127.0.0.1'; $env:API_HNQ_PORT = "$Port"; $env:API_HNQ_BODY_LIMIT = "$BodyLimit"; $env:API_HNQ_PUBLIC_ORIGIN = 'https://apihnq.hnquan.com'
    Rotate-Logs; Write-Log 'Starting gateway child.'
    $child = Start-Process -FilePath $node -ArgumentList 'dist/server.js' -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Write-PidFile $appPidFile $child; Start-Sleep -Seconds 2
    if (Test-Health) { Write-Log 'Gateway health check passed.' } else { Write-Log 'Gateway health check did not pass.' }
    while (-not $child.HasExited) { Start-Sleep -Seconds 2; Rotate-Logs }
    $child.WaitForExit(); Remove-Item -Force -LiteralPath $appPidFile -ErrorAction SilentlyContinue
    Write-Log "Gateway exited with code $($child.ExitCode); restarting in $delay seconds."; Start-Sleep -Seconds $delay; $delay = [Math]::Min($delay * 2, 30)
  }
} finally { Remove-Item -Force -LiteralPath $pidFile,$appPidFile -ErrorAction SilentlyContinue }
