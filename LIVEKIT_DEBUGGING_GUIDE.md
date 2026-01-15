# LiveKit Token Invalid Authorization - Debugging & Fix Guide

## Problem Summary
❌ **Error**: "invalid authorization token" from LiveKit server
- Frontend gets token from backend
- Token validation fails when connecting to LiveKit
- Broadcast cannot start

## Root Causes Identified

### 1. **JWT Token Generation Issues**
- ✅ Backend generates tokens with `AccessToken` from `livekit-server-sdk`
- ✅ Uses `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from `.env`
- ✅ Token includes proper claims: `roomJoin`, `rooms`, `canPublish`, `canSubscribe`

### 2. **Potential Issues to Check**
- ❓ LiveKit API credentials might be invalid or expired
- ❓ LiveKit server might not be properly configured
- ❓ Token signing algorithm mismatch
- ❓ Room name format issues
- ❓ User identity string length or format issues

## Current Configuration

### Backend (.env)
```
LIVEKIT_URL=wss://eyra-8at81fjw.livekit.cloud
LIVEKIT_API_KEY=APIJ6Cnro4AHqqQ
LIVEKIT_API_SECRET=s9JibGKNgc2BTTsxCmGRewxo2GiDN0KrUinfsGpjT1J
```

### Token Generation (liveController.js)
```javascript
const at = new AccessToken(
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
  { identity: String(userId) }
);

at.addGrant({
  roomJoin: true,
  rooms: [roomId],
  canPublish: true,
  canSubscribe: true,
  canPublishData: true
});

const token = at.toJwt();
```

## Step-by-Step Debugging

### Step 1: Verify LiveKit Credentials
Run this endpoint to test token generation:

```bash
curl -X POST http://192.168.1.106:5000/api/live/debug/generate-test-token \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "decoded": {
    "header": {"alg": "HS256", "typ": "JWT"},
    "payload": {
      "sub": "USER_ID",
      "aud": "livekit",
      "iat": 1234567890,
      "exp": 1234571490,
      "video": {...}
    }
  },
  "livekitUrl": "wss://eyra-8at81fjw.livekit.cloud"
}
```

### Step 2: Check Backend Logs During Broadcast Start
Look for logs like:
```
🔵 [generateHostToken] Creating token...
   userId: 696546cd8583356234ce59bc (type: string)
   roomId: room_1768251594373_0c751329
   LIVEKIT_API_KEY: ✓ SET (APIJ6...)
   LIVEKIT_API_SECRET: ✓ SET (s9JibG...)
   identity: 696546cd8583356234ce59bc (length: 24)
✅ [generateHostToken] Token created successfully
   Header: {"alg":"HS256","typ":"JWT"}
   Payload: {
     "sub": "696546cd8583356234ce59bc",
     "aud": "livekit",
     "video": {
       "roomJoin": true,
       "canPublish": true,
       "canSubscribe": true,
       "canPublishData": true
     }
   }
```

### Step 3: Check Flutter Logs During Connection
Look for Flutter console output:
```
✅ Using provided LiveKit token
🔍 Token details:
   Length: 500 (approximately)
   Prefix: eyJhbGciOiJIUzI1NiIsInR5c...
🔌 Attempting to connect to LiveKit...
   URL: wss://eyra-8at81fjw.livekit.cloud
   Room: room_1768251594373_0c751329
❌ LiveKit connection error: invalid authorization token
```

## Common Solutions

### Solution 1: Verify API Credentials
1. Go to LiveKit Cloud Console: https://cloud.livekit.io
2. Check your project's API keys
3. Ensure `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` match exactly
4. **Important**: API Secret must be exactly as shown (no copy errors!)

### Solution 2: Check Room Name Format
- Room names must be alphanumeric + hyphens + underscores
- Current format: `room_<timestamp>_<uuid8>`
- ✅ Example: `room_1768251594373_0c751329` (VALID)

### Solution 3: Validate User Identity
- Must be non-empty string
- Should be URL-safe
- Max length: typically 256 chars
- Current: MongoDB ObjectId as string (24 chars) ✅

### Solution 4: Check LiveKit Server Status
```bash
# Test connectivity to LiveKit server
curl -I wss://eyra-8at81fjw.livekit.cloud
```

If connection fails, LiveKit server might be:
- Down for maintenance
- Wrong URL in configuration
- Network/firewall issues

### Solution 5: Regenerate API Keys
1. Log into LiveKit Cloud Console
2. Go to Settings → API Keys
3. Generate new API Key and Secret
4. Update `.env` file
5. Restart backend server

## Advanced Debugging

### Enable Verbose Logging
Add to `src/server.js`:
```javascript
// Enable livekit-server-sdk verbose logging if available
process.env.DEBUG = 'livekit:*';
```

### Decode JWT Token Manually
```bash
# Use jwt.io or this command:
node -e "
const token = 'YOUR_TOKEN_HERE';
const parts = token.split('.');
const header = JSON.parse(Buffer.from(parts[0], 'base64'));
const payload = JSON.parse(Buffer.from(parts[1], 'base64'));
console.log('Header:', header);
console.log('Payload:', payload);
"
```

### Test with LiveKit CLI
```bash
# If you have livekit-cli installed
livekit-cli create-token \
  --api-key APIJ6Cnro4AHqqQ \
  --api-secret s9JibGKNgc2BTTsxCmGRewxo2GiDN0KrUinfsGpjT1J \
  --room my-test-room \
  --identity test-user \
  --valid-for 3600
```

## File Changes Made

### Backend Changes
1. **src/controllers/liveController.js**
   - Enhanced `generateHostToken()` with detailed logging
   - Enhanced `generateViewerToken()` with JWT decoding for verification
   - Added token payload inspection

2. **src/routes/liveRoutes.js**
   - Added `POST /api/live/debug/generate-test-token` endpoint
   - Allows testing token generation without starting actual broadcast
   - Returns decoded JWT payload for inspection

### Frontend Changes
1. **lib/features/live/screens/live_broadcast_screen.dart**
   - Added comprehensive error messages for token issues
   - Improved JWT validation before connection
   - Better error categorization (token vs network vs server)

2. **lib/features/live/services/live_api_service.dart**
   - Enhanced `_extractToken()` with debugging output
   - Logs token source and extraction method

3. **lib/features/live/screens/start_live_screen.dart**
   - Fixed RenderFlex overflow by wrapping Column in SingleChildScrollView
   - Improved layout responsiveness

## Testing Checklist

- [ ] Backend started successfully and loads `.env`
- [ ] `/api/live/debug/token-check` returns 200 with valid token
- [ ] `/api/live/debug/generate-test-token` returns proper JWT payload
- [ ] Token payload includes: `sub`, `aud: livekit`, `video` with proper grants
- [ ] Token has valid `exp` (expiration) time
- [ ] Flutter app connects to backend successfully (no 404/401 errors)
- [ ] LiveKit token is received and not empty
- [ ] Flutter can decode JWT token (3 parts separated by dots)
- [ ] LiveKit WebSocket URL is reachable from device
- [ ] No CORS issues in browser console (if testing via web)

## Next Steps If Issue Persists

1. **Regenerate all API credentials**
   - Create new API key/secret in LiveKit console
   - Update `.env`
   - Restart backend

2. **Check LiveKit Server Status**
   - Verify server URL is correct
   - Check if it's a self-hosted or cloud instance
   - Ensure firewall allows WSS connections

3. **Review LiveKit Documentation**
   - Check token claims format for your SDK version
   - Verify grants structure matches expected format
   - Review any recent API changes

4. **Contact LiveKit Support**
   - Share token decoding output from step 1
   - Include error message and timestamps
   - Include browser/device info

## Quick Recovery Commands

```bash
# Restart backend
cd c:\Users\Casper\Desktop\eyra-backend
npm start

# Test token generation
curl -X POST http://192.168.1.106:5000/api/live/debug/generate-test-token \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"

# Check .env is loaded
grep LIVEKIT .env
```

---

**Last Updated**: January 13, 2026
**Status**: Implementation Complete - Ready for Testing
