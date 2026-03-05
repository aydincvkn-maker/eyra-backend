# EYRA Backend — Security & Quality Audit Report v2

**Date:** 2025-07-10  
**Scope:** Full source code review of every file in `src/`  
**Stack:** Express 5.1 · MongoDB/Mongoose 9 · Socket.io 4.8 · Redis (ioredis) · LiveKit · Firebase Admin  

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | 5 |
| 🟠 HIGH | 11 |
| 🟡 MEDIUM | 14 |
| 🔵 LOW | 8 |
| **Total** | **38** |

---

## 🔴 CRITICAL

### C-1: `postGiftHooks` never called after gift sending — transactions not recorded

**File:** `src/services/giftService.js`  
**Lines:** `sendGift()` (~55–140) never calls `postGiftHooks()` (~150–200)

**Description:** `sendGift()` performs the atomic coin transfer and emits socket events, but **never calls `postGiftHooks()`**. `giftController.js` only calls `giftService.sendGift()`. This means:
- No `Transaction` records are created for gift_sent / gift_received
- Mission progress (`send_gift`) is never tracked
- Achievement checks (`checkGiftSentAchievements`, `checkGiftReceivedAchievements`, `checkCoinAchievements`) never run
- Sender XP is never awarded

**Impact:** Complete loss of financial audit trail for gifts. Admin finance dashboards and transaction history are missing all gift transactions. Missions and achievements are broken for gifting.

**Fix:**
```js
// At the end of sendGift(), before the return, add:
this.postGiftHooks({
  senderId,
  recipientId: actualRecipientId,
  giftId: gift._id,
  giftValue: gift.valueCoins,
  senderCoins: updatedSender.coins,
  recipientCoins: updatedRecipient.coins,
}).catch(err => console.error("postGiftHooks error:", err));
```

---

### C-2: Client-controlled paid call billing — `call:coin_tick` trusts client timing

**File:** `src/socket/callHandlers.js`, lines ~75–130

**Description:** The `call:coin_tick` socket event is emitted by the **client** at each minute interval. The server charges coins based on this client-initiated event. A malicious client can:
- Never emit `call:coin_tick` → free calls
- Emit it at slower intervals → reduced charges
- Emit rapid ticks (partially mitigated by `minuteIndex` dedup, but client can simply skip ticks)

**Impact:** Revenue loss. Users can make paid calls without being charged.

**Fix:** Move billing to a server-side `setInterval` timer started on `call:accept` and cleared on `call:end`. The server must be the authoritative source of billing time.

---

### C-3: Debug routes expose destructive operations without authentication

**File:** `src/routes/debugRoutes.js` + `src/server.js` lines ~280–290

**Description:** When `NODE_ENV !== 'production'` AND `ALLOW_PUBLIC_DEBUG_ROUTES === 'true'`, debug routes mount **without any auth**:
```js
if (NODE_ENV === 'production' || !allowPublicDebugInDev) {
  app.use('/api/debug', authMiddleware, adminMiddleware, debugRoutes);
} else {
  app.use('/api/debug', debugRoutes);  // NO AUTH
}
```

These unauthenticated endpoints include:
- `DELETE /api/debug/delete-fake-users` — deletes users from DB
- `POST /api/debug/reset-all-offline` — mass-updates all users
- `POST /api/debug/update-user-gender` — modifies any user's gender
- `GET /api/debug/list-all-users` — dumps all user records
- `GET /api/debug/socket-status` — dumps socket maps with user IDs
- `GET /api/debug/presence` — dumps all online user presence

The server listens on `0.0.0.0`, so dev servers on cloud/Docker are network-accessible.

**Impact:** Unauthorized data access, user deletion, mass data modification.

**Fix:** Always require `authMiddleware + adminMiddleware` for debug routes. Remove the `allowPublicDebugInDev` bypass.

---

### C-4: Firebase `serviceAccountKey.json` committed to repository

**File:** `serviceAccountKey.json` (project root)

**Description:** The Firebase service account key file is in the project root. This grants full admin access to the Firebase project (Firestore, FCM, Auth, Storage, etc.).

**Impact:** If the repo is anywhere other than a strictly private local machine, full Firebase project compromise.

**Fix:**
1. Add `serviceAccountKey.json` to `.gitignore`
2. Rotate the service account key in Google Cloud Console immediately
3. Use `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable instead of file
4. Use `git filter-branch` or BFG Repo-Cleaner to remove from history

---

### C-5: Hardcoded dev JWT secret used as fallback

**File:** `src/config/env.js`, lines ~43–51

**Description:** When `JWT_SECRET` is not set and `NODE_ENV !== 'production'`:
```js
const devFallback = "dev_only_change_this_secret";
```
This is a known, predictable secret. Any non-production deployment that is internet-facing (staging, QA, preview env) allows **any attacker to forge valid JWTs**.

**Impact:** Complete authentication bypass on non-production deployments.

**Fix:** Remove the fallback. Always require `JWT_SECRET` via environment variable. Fail fast if missing, regardless of `NODE_ENV`.

---

## 🟠 HIGH

### H-1: Admin namespace role check uses wrong value — `"superadmin"` vs `"super_admin"`

**File:** `src/socket/adminNamespace.js`, line ~35

**Description:**
```js
if (!["admin", "superadmin"].includes(user.role))
```
But the User model and all other middleware (`admin.js`, `requirePermission.js`) use `"super_admin"` (with underscore). **Super_admin users are rejected** from the admin socket namespace.

**Impact:** Super admins cannot connect to the admin real-time namespace (admin panel live features broken for super admins).

**Fix:** Change to `["admin", "super_admin"]`.

---

### H-2: In-memory rate limiting fails in multi-instance deployment

**File:** `src/middleware/rateLimit.js`

**Description:** Rate limiting uses plain `Map` in process memory. With Socket.io Redis adapter already configured for multi-instance support, requests load-balanced to different instances bypass rate limits completely.

Same issue in:
- `giftRateLimits` Map in `src/services/giftService.js`
- Chat rate limits in `src/services/chatService.js`
- `userConnectionTimestamps` in `src/socket/state.js`

**Impact:** Rate limits are trivially bypassed in any scaled deployment.

**Fix:** Use Redis-backed rate limiting (sliding window with `INCR`/`EXPIRE`) or `rate-limiter-flexible` with Redis store.

---

### H-3: In-memory socket state breaks multi-instance deployment

**File:** `src/socket/state.js` + `src/routes/callRoutes.js`

**Description:** Core application state in process-local Maps:
- `userSockets` — socket→user mapping
- `activeCalls` — active call sessions
- `pendingCalls` — incoming call queue
- `callRequests` (global) — paid call metadata
- `callTimeouts` in `callRoutes.js` — call answer timeouts

With Redis adapter, socket events broadcast across instances, but **application state is not shared**. User on instance A calling someone on instance B = broken state.

**Impact:** Calls, presence, and gift delivery fail intermittently when horizontally scaled.

**Fix:** Move shared state to Redis hashes/sets. Use Redis pub/sub for state change notifications across instances.

---

### H-4: `call:ended` event broadcast to ALL connected sockets

**File:** `src/routes/callRoutes.js`, POST `/end` handler, line ~250

**Description:**
```js
global.io.emit('call:ended', {
  roomName,
  endedBy: String(userId),
  timestamp: Date.now()
});
```
This broadcasts to **every** connected socket in the application.

**Impact:** Information disclosure — all users see every call end event, leaking who calls whom.

**Fix:** Emit only to participants using `emitToUserSockets(callerId, ...)` and `emitToUserSockets(targetUserId, ...)`.

---

### H-5: Plaintext password comparison still active

**File:** `src/models/User.js` — `comparePassword` method

**Description:**
```js
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (this.password && this.password.startsWith('$2')) {
    return bcrypt.compare(candidatePassword, this.password);
  }
  return this.password === candidatePassword; // PLAINTEXT COMPARE
};
```
Legacy users with unhashed passwords can log in. If the database leaks, their passwords are immediately visible.

**Impact:** Database breach exposes plaintext passwords for legacy users.

**Fix:** Run a one-time migration to hash all remaining plaintext passwords. Refuse plaintext login and force password reset instead.

---

### H-6: No input validation/sanitization on socket events

**Files:** `src/socket/callHandlers.js`, `chatHandlers.js`, `liveHandlers.js`

**Description:** Socket event handlers accept arbitrary client data without validation:
- `roomName` — no format validation
- `content` — only length check in some handlers
- `roomId` — no ObjectId validation  
- `targetUserId` — no format check in call handlers
- `data.to` in chat — no format validation

HTTP routes apply `sanitizeMongoQuery` middleware, but socket events bypass this entirely.

**Impact:** Potential NoSQL injection via socket events, XSS in stored messages, data corruption from malformed IDs.

**Fix:** Add validation middleware for socket events. Validate IDs are valid MongoDB ObjectIds and sanitize string inputs.

---

### H-7: Unofficial Google Translate API — unreliable and TOS-violating

**File:** `src/services/translationService.js`, lines ~30–50

**Description:** Uses `https://translate.googleapis.com/translate_a/single` — an undocumented, unofficial endpoint with no SLA, no API key, and no guarantee of availability.

**Impact:** Translation can break unpredictably in production. Potential legal/TOS risk.

**Fix:** Use the official Google Cloud Translation API with an API key, or DeepL / LibreTranslate.

---

### H-8: Redis `KEYS` command used for cache invalidation

**File:** `src/services/liveService.js` — `invalidateStreamCache()`

**Description:** Uses Redis `KEYS` pattern scan which is O(N) on the entire keyspace and **blocks Redis** during execution. Redis docs explicitly warn against production use.

**Impact:** Redis becomes unresponsive under high load, affecting all Redis-dependent features.

**Fix:** Use `SCAN` with cursor iteration, or use predictable key names and delete directly. Prefer key TTL as the primary eviction.

---

### H-9: `callTimeouts` Map leaks memory and is lost on crash

**File:** `src/routes/callRoutes.js`, lines ~10–15

**Description:** `const callTimeouts = new Map()` stores `setTimeout` references for unanswered calls:
1. Server crash/restart → all timeouts lost → users stuck as "busy" permanently
2. No periodic cleanup sweep (unlike `activeCalls` in `cleanup.js`)
3. Not accessible from `disconnectHandler.js` for cleanup on disconnect

**Impact:** Users permanently stuck as "busy" after server restart during active calls.

**Fix:** Add `callTimeouts`/call state cleanup to the startup stale-user reset in `server.js`. Export `clearCallTimeout` for use in `disconnectHandler.js`. Add to `cleanup.js` sweep.

---

### H-10: Payment webhook has no IP allowlist + mock provider uses default secret

**File:** `src/routes/paymentRoutes.js` + `src/controllers/paymentController.js`

**Description:** Stripe webhook verifies signature but doesn't restrict source IP. The mock provider webhook in dev accepts any POST with valid HMAC — but `PAYMENT_WEBHOOK_SECRET` defaults to `"dev_payment_webhook_secret"` in dev, so anyone can forge webhook events.

**Impact:** In dev mode with default secrets, fake payment completions can grant unlimited coins.

**Fix:** (1) Add IP allowlist for Stripe webhook IPs in production. (2) Generate random webhook secrets even in dev.

---

### H-11: No CSRF protection for cookie-based authentication

**File:** `src/middleware/auth.js`, line ~15

**Description:** Auth middleware extracts JWT from both `Authorization: Bearer` header AND `req.cookies?.token`. Cookie-based auth without CSRF tokens allows cross-site request forgery — cookies are sent automatically by browsers.

**Impact:** Any website can trigger authenticated API calls for users who logged in via cookies.

**Fix:** Set `SameSite=Strict` on auth cookies and/or add CSRF token validation. Or remove cookie-based auth entirely.

---

## 🟡 MEDIUM

### M-1: Duplicate health check routes — detailed version unreachable

**File:** `src/server.js`

**Description:** `/api/health` is defined THREE times:
1. Line ~260: simple `{ ok: true }` (this one wins)
2. Line ~310: detailed version checking MongoDB + Redis status (NEVER REACHED)
3. `/health` is also defined twice

Express matches the first route. The detailed health check verifying real service health **never runs**.

**Impact:** Monitoring thinks the server is healthy even when MongoDB or Redis is down.

**Fix:** Remove the simple definitions. Keep only the detailed health check.

---

### M-2: `viewerCount` can go negative — race condition

**File:** `src/socket/liveHandlers.js`, lines ~60–90

**Description:** `live:leave_room` uses `$inc: { viewerCount: -1 }`. If a user disconnects multiple times (reconnect race) or the same leave fires twice, the count goes negative. A band-aid fix exists:
```js
if (finalCount < 0) {
  await LiveStream.updateOne(..., { $set: { viewerCount: 0 } });
}
```
But between the negative `$inc` and the `$set`, other readers see the negative value.

**Impact:** Incorrect viewer counts in UI and analytics.

**Fix:** Track viewers via `$addToSet` / `$pull` on a `viewers` array (already done partially) and derive count from array length, or use `$max` to floor at zero in an update pipeline.

---

### M-3: Global variable pollution

**File:** `src/server.js` lines ~140–145, various consumers

**Description:** Critical state on `global`: `global.io`, `global.userSockets`, `global.activeCalls`, `global.pendingCalls`. Accessed from controllers, routes, and socket handlers without explicit imports.

**Impact:** Hidden coupling, impossible to unit test, hard to reason about data flow.

**Fix:** Use explicit dependency injection or module-level singletons accessible via `require()`.

---

### M-4: Translation cache has no LRU eviction — triggers stampede

**File:** `src/services/translationService.js`

**Description:** Cache uses a plain object. When it reaches 1000 entries, it **flushes everything** at once. All subsequent requests miss the cache simultaneously and hit the Google API, causing a stampede.

**Impact:** Burst of translation API calls, potential rate limiting or blocking.

**Fix:** Use `lru-cache` npm package for proper LRU eviction one entry at a time.

---

### M-5: Missing pagination limits in some endpoints

**Files:** Various

**Description:**
- `GET /api/debug/list-all-users` — returns ALL users, no limit
- `GET /api/debug/check-online-status` — returns ALL online users
- `giftService.getLiveGiftStats()` — loads ALL gift messages into memory

**Impact:** Memory exhaustion on large datasets, possible OOM.

**Fix:** Enforce pagination with caps on all list endpoints.

---

### M-6: Express 5.1 is not yet a stable release

**File:** `package.json`

**Description:** Express 5.1.0 is used. Express 5.x has breaking changes from 4.x and is not yet declared officially stable by the Express team.

**Impact:** Undiscovered bugs, limited community resources, potential breaking patches.

**Fix:** Pin exact version. Monitor Express 5 stability announcements. Consider Express 4.21.x as fallback.

---

### M-7: Verbose debug logging exposes sensitive data

**File:** `src/controllers/liveController.js`

**Description:** LiveKit token generation logs include connection URLs and token details via `console.log`.

**Impact:** Sensitive LiveKit credentials in logs, which could be sent to third-party log aggregators.

**Fix:** Use `logger.debug()` with production log level filtering. Never log tokens.

---

### M-8: `deletedFor` array on messages grows unbounded

**File:** `src/services/chatService.js`

**Description:** "Delete for me" uses `$addToSet: { deletedFor: userId }`. While there's a natural limit (only active users), there's no hard cap on array size.

**Impact:** Minor — document size growth.

**Fix:** Consider periodic cleanup of `deletedFor` entries for deleted users.

---

### M-9: Orphaned stream cleanup has type inconsistency

**File:** `src/jobs/cleanup.js`, lines ~100–110

**Description:** When `host` is null (user deleted), `s.host` is a raw ObjectId. `closeActiveLiveStreamsForHost` converts to `String(userId)` internally, but the Mongoose query `{ host: uid }` may not match if `host` field stores ObjectId vs string inconsistently.

**Impact:** Some orphaned streams may not be cleaned up.

**Fix:** Always use `String(s.host)` and ensure consistent type handling.

---

### M-10: Socket disconnect doesn't clean up `callTimeouts`

**File:** `src/socket/disconnectHandler.js`

**Description:** Disconnect handler cleans up presence and live rooms but NOT call timeouts from `callRoutes.js`. The timeout Map is inaccessible from the disconnect handler.

**Impact:** Stale timeouts fire on already-disconnected users.

**Fix:** Export `clearCallTimeout` from `callRoutes.js` and call it in `disconnectHandler.js`.

---

### M-11: Commission rates are hardcoded magic numbers

**Files:** `src/services/giftService.js` (45%), `src/socket/callHandlers.js` (70%)

**Description:** Platform commission differs by feature with no configuration:
- Gifts: recipient gets 45%
- Calls: host gets 70%

**Impact:** Changing rates requires code changes and redeployment.

**Fix:** Move to `SystemSettings` model or `config/constants.js`.

---

### M-12: `sanitizeMongoQuery` not applied to socket events

**File:** `src/middleware/validate.js` + socket handlers

**Description:** Express middleware strips `$` and `.` keys from `req.body`/`req.query` to prevent NoSQL injection. Socket events bypass this entirely. Socket data could contain `$gt`, `$ne` operators.

**Impact:** Potential NoSQL injection via socket payloads.

**Fix:** Apply sanitization at the socket `connectionHandler` level.

---

### M-13: Password field loaded unnecessarily in some queries

**Files:** `src/controllers/achievementController.js`, `src/services/giftService.js`

**Description:** `User.findById(userId)` without `.select('-password')` loads the full user including hashed password, even though password is not needed.

**Impact:** Marginal performance concern and defense-in-depth violation.

**Fix:** Add `.select('-password')` or set `select: false` on the password schema field.

---

### M-14: `resolveGender` defaults unknown gender to "female"

**File:** `src/controllers/authController.js`

**Description:** `resolveGender(raw)` returns `'female'` when gender is not provided or not recognized. This silently assigns the wrong gender.

**Impact:** Users appear as the wrong gender in the presence system and visibility filters.

**Fix:** Make `gender` required during registration, or default to `"unspecified"`.

---

## 🔵 LOW

### L-1: Inconsistent error response format

**Files:** Throughout

**Description:** Some endpoints return `{ success, message }`, others `{ success, error }`, some `{ message }` without `success`.

**Fix:** Standardize on `sendError()` utility everywhere.

---

### L-2: Comment step numbers skip in giftService.js

**File:** `src/services/giftService.js`

**Description:** Steps go from 5 to 9, indicating removed steps without renumbering.

---

### L-3: Unused imports / dead code

**Files:** Multiple

**Description:** Some files import utilities not used in the module. `retrieveCheckoutSession` in stripeProvider is exported but not called externally.

**Fix:** Run ESLint `no-unused-vars` / `unused-imports` rules.

---

### L-4: No request ID for tracing

**Description:** No correlation ID on HTTP requests or socket events. Log entries for the same request cannot be correlated.

**Fix:** Add UUID-per-request middleware. Include in all log output.

---

### L-5: `console.log` used everywhere instead of structured logger

**Description:** Most logging uses `console.log()` with emoji prefixes. The structured `logger` from `utils/logger.js` exists but is rarely used.

**Fix:** Replace `console.log` with `logger.info` etc. throughout. Enables log level filtering in production.

---

### L-6: Morgan doesn't skip socket.io polling paths

**File:** `src/server.js`

**Description:** Morgan logs all requests including high-frequency `/socket.io/` polling, creating excessive log noise.

**Fix:** Add `/socket.io` to the morgan skip list.

---

### L-7: `pingTimeout: 120000` (2 min) is very high

**File:** `src/server.js`, Socket.io config

**Description:** Socket.io won't detect dead connections for up to 2 minutes. The presence heartbeat timeout is only 15 seconds, creating inconsistency.

**Fix:** Reduce `pingTimeout` to 30–60 seconds to align with presence timeouts.

---

### L-8: Missing database indexes for common query patterns

**Files:** `src/models/Transaction.js`, `Message.js`, `CallHistory.js`

**Description:** Some common query patterns lack compound indexes:
- `Transaction`: by `user` + `createdAt`
- `Message`: by `roomId` + `type`
- `CallHistory`: by `roomName`

**Impact:** Slow queries as data grows.

**Fix:** Add compound indexes matching query patterns.

---

## Architecture Recommendations

1. **Multi-instance readiness:** Redis adapter is configured but in-memory Maps aren't distributed. All Maps need Redis-backed alternatives before horizontal scaling.

2. **Testing:** No test files detected. Add integration tests for critical paths (payments, gifts, auth).

3. **Secret management:** Secrets in `.env` files. Consider AWS Secrets Manager or Vault for production.

4. **API versioning:** No versioning scheme. Add `/api/v1/` prefix now to avoid breaking changes later.

5. **TypeScript:** Consider incremental migration for type safety, especially in financial operations.

---

*End of audit report.*
