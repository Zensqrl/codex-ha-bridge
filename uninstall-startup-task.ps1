$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Root "stop-bridge.ps1")

$StartupFolder = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupFolder "Codex Home Assistant MQTT Bridge.lnk"

if (Test-Path $ShortcutPath) {
  Remove-Item $ShortcutPath
  Write-Host "Startup shortcut removed."
} else {
  Write-Host "No startup shortcut was found."
}

Read-Host "Press Enter to close"
