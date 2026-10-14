$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host ""
  Write-Host ".env has been created. Add your MQTT settings before starting the bridge."
  Write-Host "File: $Root\.env"
  Write-Host ""
  notepad ".env"
  Write-Host "Save the settings, then run this file again."
  Read-Host "Press Enter to close"
  exit 0
}

$Candidates = @()

$NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if ($NodeCommand) {
  $Candidates += $NodeCommand.Source
}

$Candidates += @(
  "$env:LOCALAPPDATA\OpenAI\Codex\bin\node.exe",
  "$env:LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin\node.exe",
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe"
)

$NodePath = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $NodePath) {
  Write-Host "Node was not found."
  Write-Host "Install Node.js 22 or a newer LTS version from https://nodejs.org, then run this file again."
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Node found: $NodePath"
Write-Host "Starting Codex Home Assistant MQTT Bridge..."
Write-Host ""

& $NodePath "src\index.js"

Read-Host "Press Enter to close"
