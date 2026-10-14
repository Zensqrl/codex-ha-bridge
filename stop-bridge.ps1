$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Root "logs\service.pid"
if (-not (Test-Path $PidFile)) { Write-Host "No tracked background runner found."; exit 0 }
$ServicePid = 0
if (-not [int]::TryParse((Get-Content $PidFile -Raw).Trim(), [ref]$ServicePid) -or $ServicePid -le 0) {
  throw "Invalid bridge PID file."
}
$Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ServicePid"
$ExpectedScript = '"' + (Join-Path $Root "run-service.ps1") + '"'
if (-not $Process) { Remove-Item $PidFile; Write-Host "Runner already stopped."; exit 0 }
if ($Process.Name -notin @("powershell.exe", "pwsh.exe") -or -not $Process.CommandLine.Contains($ExpectedScript)) {
  throw "PID does not match this bridge runner; no process was stopped."
}
# Stop only this verified runner and its child tree, including the local app-server.
& "$env:SystemRoot\System32\taskkill.exe" /PID $ServicePid /T /F > $null 2>&1
if ($LASTEXITCODE -ne 0) { throw "Could not stop this bridge runner." }
if (Test-Path $PidFile) { Remove-Item $PidFile }
Write-Host "Background bridge stopped. Broker last will will mark it offline."
