param(
  [string]$RepoPath = "C:\Users\Casper\Desktop\eyra-backend",
  [string]$Branch = "main",
  [int]$CheckIntervalSec = 30,
  [string]$LogPath = "C:\Users\Casper\Desktop\eyra-backend\scripts\autodeploy.log"
)

$ErrorActionPreference = "Continue"

$AllRepos = @(
  "C:\Users\Casper\Desktop\eyra-backend",
  "C:\Users\Casper\Desktop\eyrapanel\eyra-admin"
)

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts][$Level] $Message"
  Write-Host $line
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Invoke-ManualPush {
  Write-Log "=== MANUEL PUSH BASLADI (R) ===" "INFO"
  foreach ($repo in $AllRepos) {
    if (-not (Test-Path $repo)) {
      Write-Log "Repo bulunamadi: $repo" "WARN"
      continue
    }
    Push-Location $repo
    try {
      $st = git status --porcelain 2>$null
      if ($st) {
        $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git add -A 2>$null
        git commit -m "manual: push at $ts" 2>$null | Out-Null
        Write-Log "Commit yapildi: $repo"
      }
      git pull --rebase origin $Branch --autostash --quiet 2>$null | Out-Null
      git push origin $Branch 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Log "PUSH OK: $repo" "INFO"
        Write-Host ""
        Write-Host "  >> $([System.IO.Path]::GetFileName($repo)) PUSHED OK" -ForegroundColor Green
        Write-Host ""
      } else {
        Write-Log "Push basarisiz: $repo" "ERROR"
        Write-Host "  >> $([System.IO.Path]::GetFileName($repo)) PUSH FAILED" -ForegroundColor Red
      }
    } catch {
      Write-Log ("Manuel push hata: " + $_.Exception.Message) "ERROR"
    }
    Pop-Location
  }
  Write-Log "=== MANUEL PUSH TAMAMLANDI ===" "INFO"
}

function Start-InterruptibleSleep {
  param([int]$Seconds)
  $elapsed = 0
  while ($elapsed -lt ($Seconds * 1000)) {
    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq [ConsoleKey]::R) {
        Write-Host ""
        Write-Host "  >> R algilandi - aninda push yapiliyor..." -ForegroundColor Cyan
        Invoke-ManualPush
        return
      }
    }
    Start-Sleep -Milliseconds 500
    $elapsed += 500
  }
}

$mutexName = "Global\EyraUnifiedAutoDeploy"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  Write-Host "Baska bir instance zaten calisiyor. Cikiliyor."
  exit 0
}

try {
  if (-not (Test-Path $RepoPath)) {
    throw "RepoPath bulunamadi: $RepoPath"
  }

  if (-not (Test-Path (Split-Path $LogPath -Parent))) {
    New-Item -ItemType Directory -Path (Split-Path $LogPath -Parent) -Force | Out-Null
  }

  Set-Location $RepoPath

  $gitCheck = git rev-parse --is-inside-work-tree 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Git repo degil: $RepoPath"
  }

  Write-Log "Auto-deploy basladi. repo=$RepoPath branch=$Branch interval=${CheckIntervalSec}s"
  Write-Host ""
  Write-Host "====================================" -ForegroundColor Cyan
  Write-Host " Eyra Auto-Deploy AKTIF" -ForegroundColor Cyan
  Write-Host " [R] = Aninda push yap" -ForegroundColor Yellow
  Write-Host " [Ctrl+C] = Cikis" -ForegroundColor Gray
  Write-Host "====================================" -ForegroundColor Cyan
  Write-Host ""

  while ($true) {
    try {
      Set-Location $RepoPath

      $raw = git status --porcelain 2>$null
      $lines = @($raw | Where-Object { $_ -and $_.Trim().Length -gt 0 })

      $filtered = @()
      foreach ($line in $lines) {
        $pathPart = $line.Substring(3)
        if ($pathPart -like "*->*") {
          $pathPart = ($pathPart -split "->")[-1].Trim()
        }
        if (
          $pathPart -eq "eyra-backend" -or
          $pathPart -eq "eyra-backend-new" -or
          $pathPart -like "eyra-backend/*" -or
          $pathPart -like "eyra-backend-new/*"
        ) {
          continue
        }
        $filtered += [PSCustomObject]@{ Raw = $line; Path = $pathPart }
      }

      if ($filtered.Count -eq 0) {
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      Write-Log "Degisiklik tespit edildi: $($filtered.Count) dosya"
      foreach ($item in $filtered) {
        Write-Log ("  - " + $item.Raw)
      }

      foreach ($item in $filtered) {
        git add -- "$($item.Path)" 2>$null
      }

      $staged = git diff --cached --name-only 2>$null
      if (-not $staged) {
        Write-Log "Staged dosya yok, geciliyor" "WARN"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      git fetch origin $Branch --quiet 2>$null

      $commitMsg = "auto: sync backend changes $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
      git commit -m "$commitMsg" 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Commit basarisiz" "ERROR"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      git pull --rebase origin $Branch --autostash 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Rebase basarisiz, manuel mudahale gerekiyor" "ERROR"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      git push origin $Branch 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Push basarisiz" "ERROR"
        Start-InterruptibleSleep -Seconds $CheckIntervalSec
        continue
      }

      Write-Log "Push basarili. Render deploy basliyor."

      if ($env:EYRA_RENDER_DEPLOY_HOOK_URL) {
        try {
          Invoke-RestMethod -Method Post -Uri $env:EYRA_RENDER_DEPLOY_HOOK_URL | Out-Null
          Write-Log "Render deploy hook tetiklendi"
        } catch {
          Write-Log ("Render hook hatasi: " + $_.Exception.Message) "WARN"
        }
      }
    } catch {
      Write-Log ("Dongu hatasi: " + $_.Exception.Message) "ERROR"
    }

    Start-InterruptibleSleep -Seconds $CheckIntervalSec
  }
} finally {
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    try { $mutex.Dispose() } catch {}
  }
}