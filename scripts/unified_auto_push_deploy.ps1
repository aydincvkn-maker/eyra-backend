param(
  [string]$RepoPath = "C:\Users\Casper\Desktop\eyra-backend",
  [string]$Branch = "main",
  [int]$CheckIntervalSec = 30,
  [string]$LogPath = "C:\Users\Casper\Desktop\eyra-backend\scripts\autodeploy.log"
)

$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$ts][$Level] $Message"
  Write-Host $line
  Add-Content -Path $LogPath -Value $line
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
        Start-Sleep -Seconds $CheckIntervalSec
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
        Start-Sleep -Seconds $CheckIntervalSec
        continue
      }

      # remote güncel mi kontrol et
      git fetch origin $Branch --quiet

      $commitMsg = "auto: sync backend changes $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
      git commit -m "$commitMsg" | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Commit failed, skipping this cycle" "ERROR"
        Start-Sleep -Seconds $CheckIntervalSec
        continue
      }

      # Push öncesi rebase dene
      git pull --rebase origin $Branch --autostash | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Rebase failed, please resolve manually" "ERROR"
        Start-Sleep -Seconds $CheckIntervalSec
        continue
      }

      git push origin $Branch | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Log "Push failed" "ERROR"
        Start-Sleep -Seconds $CheckIntervalSec
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

    Start-Sleep -Seconds $CheckIntervalSec
  }
}
finally {
  if ($mutex) {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
  }
}
