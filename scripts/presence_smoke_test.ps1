$ErrorActionPreference = 'Stop'

# Ensure UTF-8 output (prevents garbled emoji/characters on Windows consoles)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

# Also set console code page to UTF-8 for external programs
try { chcp 65001 | Out-Null } catch {}

Set-Location 'c:\Users\Casper\Desktop\eyra-backend'

$env:NODE_ENV = 'development'
$env:PRESENCE_ENABLE_SERVER_HEARTBEAT = 'false'
$env:SOCKET_KICK_DIFFERENT_USER_SAME_IP = 'false'

# Use a dedicated port for the smoke test to avoid conflicts with any running dev server.
$env:PORT = '5055'
$env:BASE_URL = 'http://127.0.0.1:5055'

$serverLog = Join-Path $PWD 'presence_smoke_server.log'
$serverErrLog = Join-Path $PWD 'presence_smoke_server.err.log'
$testLog = Join-Path $PWD 'presence_smoke_test.log'

Remove-Item -Force -ErrorAction SilentlyContinue $serverLog, $serverErrLog, $testLog

Write-Host "[START] Backend on $($env:PORT) (NODE_ENV=$($env:NODE_ENV), PRESENCE_ENABLE_SERVER_HEARTBEAT=$($env:PRESENCE_ENABLE_SERVER_HEARTBEAT))"

# Start backend as a detached process with log redirection (more reliable than Start-Job piping)
$serverProc = Start-Process -FilePath 'node' -ArgumentList @('src/server.js') -WorkingDirectory 'c:\Users\Casper\Desktop\eyra-backend' -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrLog -NoNewWindow -PassThru

try {
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $h = Invoke-RestMethod -Uri "$($env:BASE_URL)/api/health" -TimeoutSec 2
      if ($h.status -eq 'ok') { $ok = $true; break }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  if (-not $ok) {
    Write-Host '❌ Server did not become healthy in time.'
    if (Test-Path $serverLog) {
      Write-Host '--- server log (tail) ---'
      Get-Content $serverLog -Tail 80
    }
    if (Test-Path $serverErrLog) {
      Write-Host '--- server err log (tail) ---'
      Get-Content $serverErrLog -Tail 80
    }
    exit 1
  }

  Write-Host '[OK] Server healthy. Running socket presence test...'
  node .\test_presence_socket.js 2>&1 | Tee-Object -FilePath $testLog | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Socket smoke test failed (exit code $LASTEXITCODE). See $testLog"
  }

} finally {
  Write-Host '[CLEANUP] Stopping backend...'
  try {
    if ($serverProc -and -not $serverProc.HasExited) {
      Stop-Process -Id $serverProc.Id -Force
      Write-Host "[CLEANUP] Stopped server PID $($serverProc.Id)"
    }
  } catch {}

  # Ensure port is not left open (kills detached npm/node if any)
  $conn = Get-NetTCPConnection -LocalPort ([int]$env:PORT) -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    try {
      Stop-Process -Id $conn.OwningProcess -Force
      Write-Host "[CLEANUP] Killed PID $($conn.OwningProcess) on port $($env:PORT)"
    } catch {}
  }

  Write-Host '[DONE] Smoke test finished.'
}
