$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "bridge.log"
$PidFile = Join-Path $LogDir "service.pid"
$Hash = [Security.Cryptography.SHA256]::Create()
$RootHash = [BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace("-", "")
$Hash.Dispose()
$Mutex = New-Object Threading.Mutex($false, "Local\CodexHaBridge-$RootHash")
$OwnsMutex = $false

function Write-ServiceLog($Message) {
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) {
    for ($i = 3; $i -ge 1; $i--) {
      $Previous = if ($i -eq 1) { $LogFile } else { "$LogFile.$($i - 1)" }
      $Next = "$LogFile.$i"
      if (Test-Path $Next) { Remove-Item $Next }
      if (Test-Path $Previous) { Move-Item $Previous $Next }
    }
  }
  Add-Content -Path $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

try {
  try { $OwnsMutex = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $OwnsMutex = $true }
  if (-not $OwnsMutex) { exit 0 }
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
  Set-Content -Path $PidFile -Value $PID
  if (-not (Test-Path ".env")) {
    Write-ServiceLog "CONFIG_INVALID: Create .env and follow README secure setup."
    exit 1
  }
  $NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  $Candidates = @()
  if ($NodeCommand) { $Candidates += $NodeCommand.Source }
  $Candidates += @(
    "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe",
    "$env:LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin\node.exe",
    "$env:ProgramFiles\nodejs\node.exe"
  )
  $NodePath = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $NodePath) { Write-ServiceLog "Node.js 22 or newer was not found."; exit 1 }
  $env:BRIDGE_LOG_TO_FILE = "true"
  while ($true) {
    # Node writes sanitized, rotated logs. Suppress native startup diagnostics.
    & $NodePath "src\index.js" > $null 2>&1
    Write-ServiceLog "Bridge stopped. Restarting in 30 seconds."
    Start-Sleep -Seconds 30
  }
} catch {
  if (Test-Path $LogDir) { Write-ServiceLog "Background runner failed; check README setup requirements." }
} finally {
  if ($OwnsMutex) {
    if (Test-Path $PidFile) { Remove-Item $PidFile -ErrorAction SilentlyContinue }
    $Mutex.ReleaseMutex()
  }
  $Mutex.Dispose()
}
