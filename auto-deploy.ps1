# ============================================
#  EYRA BACKEND - Auto Deploy Watcher
#  3 saniyede bir dosya degisikligi kontrol
#  [r] manuel deploy   [q] cikis
# ============================================

$Host.UI.RawUI.WindowTitle = "BACKEND - Deploy Watcher"
$projectDir = "c:\Users\Casper\Desktop\eyra-backend"
$checkIntervalSeconds = 3
$deployDelaySeconds = 30

Set-Location $projectDir

function Get-ProjectHash {
    $excludeDirs = @("node_modules", ".git", "build", "dist", "uploads")
    $files = Get-ChildItem -Path $projectDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            $path = $_.FullName
            $skip = $false
            foreach ($ex in $excludeDirs) {
                if ($path -match [regex]::Escape("$projectDir\$ex")) { $skip = $true; break }
            }
            -not $skip
        } |
        Select-Object FullName, LastWriteTime, Length

    if ($files.Count -eq 0) { return "empty" }
    $hashInput = ($files | ForEach-Object { "$($_.FullName)|$($_.LastWriteTime)|$($_.Length)" }) -join "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($hashInput)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', ''
}

function Deploy-GitPush {
    param([string]$Message = "")

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host "  BACKEND DEPLOY - $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Magenta
    Write-Host "========================================" -ForegroundColor Magenta

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    if ([string]::IsNullOrEmpty($Message)) { $Message = "auto-deploy: $timestamp" }

    Write-Host "[1/3] git add ..." -ForegroundColor Yellow
    git add -A 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

    Write-Host "[2/3] git commit ..." -ForegroundColor Yellow
    $commitOutput = git commit -m $Message 2>&1
    $commitOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

    if ($commitOutput -match "nothing to commit") {
        Write-Host "  Degisiklik yok." -ForegroundColor DarkYellow
        return $true
    }

    Write-Host "[3/3] git push ..." -ForegroundColor Yellow
    git push origin main 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  HATA: Git push basarisiz!" -ForegroundColor Red
        return $false
    }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  PUSH OK -> Render deploy basliyor" -ForegroundColor Green
    Write-Host "  $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    return $true
}

# ---- BASLANGIÇ ----
Clear-Host
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "  EYRA BACKEND - Deploy Watcher" -ForegroundColor Magenta
Write-Host "  Kontrol: Her 3 saniye" -ForegroundColor Magenta
Write-Host "  Repo: eyra-backend (main)" -ForegroundColor Magenta
Write-Host "  Platform: Render (Frankfurt)" -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "  [r] Manuel deploy   [q] Cikis" -ForegroundColor DarkYellow
Write-Host ""

$lastHash = Get-ProjectHash
$changesDetected = $false
$changeTime = $null

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Izleme basladi..." -ForegroundColor DarkGray

while ($true) {
    if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'R') {
            Write-Host "`n[MANUEL] Deploy tetiklendi!" -ForegroundColor Yellow
            Deploy-GitPush -Message "manuel-deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
            $lastHash = Get-ProjectHash
            $changesDetected = $false
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Izlemeye devam..." -ForegroundColor DarkGray
        }
        elseif ($key.Key -eq 'Q') {
            Write-Host "`nCikis yapiliyor..." -ForegroundColor Yellow
            break
        }
    }

    $currentHash = Get-ProjectHash

    if ($currentHash -ne $lastHash) {
        if (-not $changesDetected) {
            $changesDetected = $true
            $changeTime = Get-Date
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Degisiklik algilandi! ${deployDelaySeconds}sn sonra deploy..." -ForegroundColor Yellow
        }
        $lastHash = $currentHash
        $changeTime = Get-Date
    }

    if ($changesDetected -and ((Get-Date) - $changeTime).TotalSeconds -ge $deployDelaySeconds) {
        Write-Host "[OTO] Deploy baslatiyor..." -ForegroundColor Yellow
        Deploy-GitPush
        $lastHash = Get-ProjectHash
        $changesDetected = $false
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Izlemeye devam..." -ForegroundColor DarkGray
    }

    Start-Sleep -Seconds $checkIntervalSeconds
}
