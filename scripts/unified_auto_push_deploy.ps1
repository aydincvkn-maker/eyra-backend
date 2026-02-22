param(
  [string]$RepoPath = "C:\Users\Casper\Desktop\eyra-backend",
  [string]$Branch = "main",
  [int]$CheckIntervalSec = 30,
  [string]$LogPath = "C:\Users\Casper\Desktop\eyra-backend\scripts\autodeploy.log"
)

$ErrorActionPreference = 'Stop'

# Tüm repo'lar — hem backend hem panel
$AllRepos = @(
  "C:\Users\Casper\Desktop\eyra-backend",
  "C:\Users\Casper\Desktop\eyrapanel\eyra-admin"
)

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$ts][$Level] $Message"
  Write-Host $line
  Add-Content -Path $LogPath -Value $line
}

# R tuşuna basınca tüm repo'ları anında push et
function Invoke-ManualPush {
  Write-Log "=== MANUEL PUSH BASLADI (R tusu) ===" "INFO"
  foreach ($repo in $AllRepos) {
    if (-not (Test-Path $repo)) { Write-Log "Repo bulunamadi: $repo" "WARN"; continue }
    Push-Location $repo
    try {
      $status = git status --porcelain 2>$null
      if ($status) {
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        git add -A 2>$null
        git commit -m "manual: push at $ts" 2>$null | Out-Null
        Write-Log "Commit yapildi: $repo"
      }
      git pull --rebase origin $Branch --autostash --quiet 2>$null | Out-Null
      git push origin $Branch 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Log "PUSH BASARILI: $repo" "INFO"
        Write-Host ""
        Write-Host "  ✅ $([System.IO.Path]::GetFileName($repo)) → pushed!" -ForegroundColor Green
        Write-Host ""
      } else {
        Write-Log "Push basarisiz: $repo" "ERROR"
      }
    } catch {
      Write-Log ("Manuel push hatasi ($repo): " + $_.Exception.Message) "ERROR"
    }
    Pop-Location
  }
  Write-Log "=== MANUEL PUSH TAMAMLANDI ===" "INFO"
}

# Bekleme süresince R tuşunu dinle
function Start-InterruptibleSleep {
  param([int]$Seconds)
  $elapsed = 0
  $tick = 500  # ms
  while ($elapsed -lt ($Seconds * 1000)) {
    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq [ConsoleKey]::R) {
        Write-Host ""
        Write-Host "  ⚡ R algilandi — aninda push yapiliyor..." -ForegroundColor Cyan
        Invoke-ManualPush
        return
      }
    }
    Start-Sleep -Milliseconds $tick
    $elapsed += $tick
  }
}

# Tek instance çalışsın
$mutexName = 'Global\EyraUnifiedAutoDeploy'
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  Write-Host "Another autodeploy instance is already running. Exiting."
  exit 0
}

try {
  if (-not (Test-Path $RepoPath)) {
    throw "RepoPath not found: $RepoPath"
  }

  if (-not (Test-Path (Split-Path $LogPath -Parent))) {
    New-Item -ItemType Directory -Path (Split-Path $LogPath -Parent) -Force | Out-Null
  }

  Set-Location $RepoPath

  git rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Not a git repository: $RepoPath"
  }

  Write-Log "Unified auto push/deploy started. repo=$RepoPath branch=$Branch interval=${CheckIntervalSec}s"
  Write-Host ""
  Write-Host "  💡 R tuşuna bas → anında tüm repo'ları push eder" -ForegroundColor Yellow
  Write-Host ""

  while ($true) {
    try {
      Set-Location $RepoPath

      # Sadece ana backend dosyalarını takip et (eski nested repo pointer'ları hariç)
      $raw = git status --porcelain
      $lines = @($raw | Where-Object { $_ -and $_.Trim().Length -gt 0 })

      $filtered = @()
      foreach ($line in $lines) {
        $pathPart = $line.Substring(3)

        # rename satırları: old -> new
        if ($pathPart -like '*->*') {
          $pathPart = ($pathPart -split '->')[-1].Trim()
        }

        if (
          $pathPart -eq 'eyra-backend' -or
          $pathPart -eq 'eyra-backend-new' -or
          $pathPart -like 'eyra-backend/*' -or
          $pathPart -like 'eyra-backend-new/*'
        ) {
          continue
        }

        $filtered += [PSCustomObject]@{ Raw = $line; Path = $pathPart }
      }

      if ($filtered.Count -eq 0) {
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      Write-Log "Changes detected: $($filtered.Count) file(s)"
      foreach ($item in $filtered) { Write-Log ("  - " + $item.Raw) }

      foreach ($item in $filtered) {
        git add -- "$($item.Path)"
      }

      # staged bir şey var mı?
      $staged = git diff --cached --name-only
      if (-not $staged) {
        Write-Log "No valid staged files after filtering; skipping commit" "WARN"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      # remote güncel mi kontrol et
      git fetch origin $Branch --quiet

      $commitMsg = "auto: sync backend changes $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
      git commit -m "$commitMsg" | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Commit failed, skipping this cycle" "ERROR"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      # Push öncesi rebase dene
      git pull --rebase origin $Branch --autostash | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Rebase failed, please resolve manually" "ERROR"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      git push origin $Branch | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Push failed" "ERROR"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      Write-Log "Push successful. Git-based deploy should start automatically."

      if ($env:EYRA_RENDER_DEPLOY_HOOK_URL) {
        try {
          Invoke-RestMethod -Method Post -Uri $env:EYRA_RENDER_DEPLOY_HOOK_URL | Out-Null
          Write-Log "Render deploy hook triggered"
        } catch {
          Write-Log ("Render deploy hook failed: " + $_.Exception.Message) "WARN"
        }
      }
    }
    catch {
      Write-Log ("Cycle error: " + $_.Exception.Message) "ERROR"
    }

    Start-InterruptibleSleep -Seconds $CheckIntervalSec
  }
}
finally {
  if ($mutex) {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
  }
}
