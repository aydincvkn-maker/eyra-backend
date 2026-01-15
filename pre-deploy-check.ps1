# PowerShell Pre-Deployment Checklist
# EYRA Backend Production Deployment Check

Write-Host "`n🔍 EYRA Backend Pre-Deployment Check" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

$script:Errors = 0
$script:Warnings = 0

function Test-EnvVariable {
    param($name, $pattern, $shouldMatch = $true)
    
    if (Select-String -Path .env -Pattern $pattern -Quiet) {
        if ($shouldMatch) {
            Write-Host "✅ $name OK" -ForegroundColor Green
            return $true
        } else {
            Write-Host "❌ $name - MUST CHANGE!" -ForegroundColor Red
            $script:Errors++
            return $false
        }
    } else {
        if ($shouldMatch) {
            Write-Host "❌ $name not found" -ForegroundColor Red
            $script:Errors++
            return $false
        } else {
            Write-Host "✅ $name changed" -ForegroundColor Green
            return $true
        }
    }
}

# Check 1: Environment Variables
Write-Host "1️⃣  Checking environment variables..." -ForegroundColor Yellow
if (!(Test-Path .env)) {
    Write-Host "❌ .env file not found" -ForegroundColor Red
    $script:Errors++
} else {
    Test-EnvVariable "NODE_ENV" "NODE_ENV=production"
    Test-EnvVariable "JWT_SECRET (default)" "JWT_SECRET=eyra_super_secret_key_321" -shouldMatch $false
    
    if (Select-String -Path .env -Pattern "SOCKET_ALLOW_INSECURE_USERID=true" -Quiet) {
        Write-Host "⚠️  SOCKET_ALLOW_INSECURE_USERID should be false" -ForegroundColor Yellow
        $script:Warnings++
    } else {
        Write-Host "✅ Socket auth secure" -ForegroundColor Green
    }
}
Write-Host ""

# Check 2: Dependencies
Write-Host "2️⃣  Checking dependencies..." -ForegroundColor Yellow
if (!(Test-Path node_modules)) {
    Write-Host "❌ node_modules not found - run 'npm install'" -ForegroundColor Red
    $script:Errors++
} else {
    Write-Host "✅ Dependencies installed" -ForegroundColor Green
}
Write-Host ""

# Check 3: Critical Files
Write-Host "3️⃣  Checking critical files..." -ForegroundColor Yellow
$criticalFiles = @(
    "src/server.js",
    "src/services/presenceService.js",
    "src/controllers/authController.js",
    "package.json"
)

foreach ($file in $criticalFiles) {
    if (Test-Path $file) {
        Write-Host "✅ $file exists" -ForegroundColor Green
    } else {
        Write-Host "❌ $file missing" -ForegroundColor Red
        $script:Errors++
    }
}
Write-Host ""

# Check 4: Documentation
Write-Host "4️⃣  Checking documentation..." -ForegroundColor Yellow
$docs = @("README.md", "PRESENCE_SYSTEM.md", "CHANGES.md", "FINAL_CHECK.md")
foreach ($doc in $docs) {
    if (Test-Path $doc) {
        Write-Host "✅ $doc exists" -ForegroundColor Green
    } else {
        Write-Host "⚠️  $doc missing" -ForegroundColor Yellow
        $script:Warnings++
    }
}
Write-Host ""

# Check 5: Test Files
Write-Host "5️⃣  Checking test files..." -ForegroundColor Yellow
if (Test-Path "test_presence_socket.js") {
    Write-Host "✅ Test file available" -ForegroundColor Green
} else {
    Write-Host "⚠️  test_presence_socket.js not found" -ForegroundColor Yellow
    $script:Warnings++
}
Write-Host ""

# Check 6: Try to connect to MongoDB (optional)
Write-Host "6️⃣  Checking MongoDB connection..." -ForegroundColor Yellow
if (Select-String -Path .env -Pattern "MONGO_URI=" -Quiet) {
    Write-Host "✅ MONGO_URI configured" -ForegroundColor Green
} else {
    Write-Host "❌ MONGO_URI not found in .env" -ForegroundColor Red
    $script:Errors++
}
Write-Host ""

# Summary
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "📊 Summary:" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan

if ($script:Errors -eq 0) {
    Write-Host "✅ All critical checks passed!" -ForegroundColor Green
    if ($script:Warnings -eq 0) {
        Write-Host "🎉 Ready for production deployment!" -ForegroundColor Green
    } else {
        Write-Host "⚠️  $($script:Warnings) warning(s) found - review before deploy" -ForegroundColor Yellow
    }
} else {
    Write-Host "❌ $($script:Errors) error(s) found - MUST fix before deploy" -ForegroundColor Red
    if ($script:Warnings -gt 0) {
        Write-Host "⚠️  $($script:Warnings) warning(s) found" -ForegroundColor Yellow
    }
}

Write-Host "`nPress any key to continue..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
