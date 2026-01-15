#!/bin/bash

# EYRA Backend Production Deployment Checklist
# Run this before deploying to production

echo "🔍 EYRA Backend Pre-Deployment Check"
echo "===================================="
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

# Check 1: Environment Variables
echo "1️⃣  Checking environment variables..."
if [ ! -f .env ]; then
    echo -e "${RED}❌ .env file not found${NC}"
    ERRORS=$((ERRORS+1))
else
    # Check NODE_ENV
    if grep -q "NODE_ENV=production" .env; then
        echo -e "${GREEN}✅ NODE_ENV=production${NC}"
    else
        echo -e "${RED}❌ NODE_ENV must be 'production'${NC}"
        ERRORS=$((ERRORS+1))
    fi
    
    # Check JWT_SECRET
    if grep -q "JWT_SECRET=eyra_super_secret_key_321" .env; then
        echo -e "${RED}❌ JWT_SECRET is still default - CHANGE IT!${NC}"
        ERRORS=$((ERRORS+1))
    else
        echo -e "${GREEN}✅ JWT_SECRET changed${NC}"
    fi
    
    # Check SOCKET_ALLOW_INSECURE_USERID
    if grep -q "SOCKET_ALLOW_INSECURE_USERID=true" .env || ! grep -q "SOCKET_ALLOW_INSECURE_USERID" .env; then
        echo -e "${YELLOW}⚠️  SOCKET_ALLOW_INSECURE_USERID should be false or removed${NC}"
        WARNINGS=$((WARNINGS+1))
    else
        echo -e "${GREEN}✅ Socket auth secure${NC}"
    fi
fi
echo ""

# Check 2: Dependencies
echo "2️⃣  Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo -e "${RED}❌ node_modules not found - run 'npm install'${NC}"
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✅ Dependencies installed${NC}"
fi
echo ""

# Check 3: Critical Files
echo "3️⃣  Checking critical files..."
FILES=("src/server.js" "src/services/presenceService.js" "package.json")
for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✅ $file exists${NC}"
    else
        echo -e "${RED}❌ $file missing${NC}"
        ERRORS=$((ERRORS+1))
    fi
done
echo ""

# Check 4: Documentation
echo "4️⃣  Checking documentation..."
DOCS=("README.md" "PRESENCE_SYSTEM.md" "CHANGES.md")
for doc in "${DOCS[@]}"; do
    if [ -f "$doc" ]; then
        echo -e "${GREEN}✅ $doc exists${NC}"
    else
        echo -e "${YELLOW}⚠️  $doc missing${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
done
echo ""

# Check 5: Port Configuration
echo "5️⃣  Checking port configuration..."
if grep -q "PORT=5000" .env; then
    echo -e "${GREEN}✅ Port configured (5000)${NC}"
else
    echo -e "${YELLOW}⚠️  PORT not set in .env, will use default${NC}"
    WARNINGS=$((WARNINGS+1))
fi
echo ""

# Summary
echo "===================================="
echo "📊 Summary:"
echo "===================================="
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✅ All critical checks passed!${NC}"
    if [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}🎉 Ready for production deployment!${NC}"
        exit 0
    else
        echo -e "${YELLOW}⚠️  $WARNINGS warning(s) found - review before deploy${NC}"
        exit 0
    fi
else
    echo -e "${RED}❌ $ERRORS error(s) found - MUST fix before deploy${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}⚠️  $WARNINGS warning(s) found${NC}"
    fi
    exit 1
fi
