$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'EyraUnifiedAutoDeploy.lnk'
$oldShortcutPath = Join-Path $startupDir 'EyraAutoCommit.lnk'
$scriptPath = 'C:\Users\Casper\Desktop\eyra-backend\scripts\unified_auto_push_deploy.ps1'

if (-not (Test-Path $scriptPath)) {
  throw "Script not found: $scriptPath"
}

if (Test-Path $oldShortcutPath) {
  Remove-Item $oldShortcutPath -Force
  Write-Host "Old startup shortcut removed: $oldShortcutPath" -ForegroundColor Yellow
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File `"$scriptPath`""
$shortcut.WorkingDirectory = 'C:\Users\Casper\Desktop\eyra-backend'
$shortcut.IconLocation = "$env:WINDIR\System32\shell32.dll,220"
$shortcut.Save()

Write-Host "Startup shortcut created/updated:" -ForegroundColor Green
Write-Host $shortcutPath -ForegroundColor Green

# Eski auto-commit processlerini kapat
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq 'powershell.exe' -and $_.CommandLine -match 'auto_commit_push\.ps1' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host "Stopped old process PID=$($_.ProcessId)" -ForegroundColor Yellow
  }

Write-Host "Setup complete. New unified autodeploy will start at next Windows login." -ForegroundColor Cyan
