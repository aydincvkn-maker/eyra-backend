# Auto Commit and Push Script for eyra-backend
$repoPath = "C:\Users\Casper\Desktop\eyra-backend"
$branch = "main"
$checkInterval = 10

Write-Host "======================================"
Write-Host " Auto Commit and Push Baslatildi!"
Write-Host "======================================"
Write-Host "Repo: $repoPath"
Write-Host "Kontrol araligi: $checkInterval saniye"
Write-Host "Durdurmak icin Ctrl+C"
Write-Host ""

Set-Location $repoPath

while ($true) {
    $status = git status --porcelain 2>$null
    
    if ($status) {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        
        Write-Host "[$timestamp] Degisiklik tespit edildi!"
        
        git add -A
        
        $commitMsg = "Auto-commit at $timestamp"
        git commit -m "$commitMsg" 2>$null
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Commit yapildi"
            
            git push origin $branch 2>$null
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Push basarili! Render deploy baslayacak..."
            }
            else {
                Write-Host "Push basarisiz!"
            }
        }
        
        Write-Host ""
    }
    
    Start-Sleep -Seconds $checkInterval
}
