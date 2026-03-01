# EYRA Backend — Comprehensive Audit Report

**Date:** 2025  
**Scope:** Full codebase audit of `eyra-backend/src/`  
**Stack:** Express 5.1.0, Mongoose 9.0.0, Socket.io 4.8.1, IORedis 5.8.2, LiveKit 2.14.2

---

## Table of Contents

1. [Security Issues](#1-security-issues)
2. [Missing Error Handling](#2-missing-error-handling)
3. [Incomplete Implementations](#3-incomplete-implementations)
4. [Missing Environment Variables / Config Issues](#4-missing-environment-variables--config-issues)
5. [Unused / Dead Code](#5-unused--dead-code)
6. [Missing Validations](#6-missing-validations)
7. [Broken Imports or Require Statements](#7-broken-imports-or-require-statements)
8. [Payment System Completeness](#8-payment-system-completeness)
9. [Database Connection Issues](#9-database-connection-issues)
10. [Missing API Endpoints / Architecture Issues](#10-missing-api-endpoints--architecture-issues)

---

## 1. Security Issues

### 1.1 — `debug` package used but NOT in dependencies (CRASH RISK)

- **File:** `src/server.js` line 141
- **Code:** `require('debug')('socket.io:*')();`
- **Problem:** The `debug` package is not listed in `package.json` dependencies or devDependencies. In development mode this line will **crash the server** with `MODULE_NOT_FOUND`.
- **Severity:** HIGH
- **Fix:** Either add `debug` to devDependencies, or remove the line.

### 1.2 — Debug routes exposed in production via env var

- **File:** `src/server.js` lines 267–276
- **Code:**
  ```js
  if (NODE_ENV !== 'production' || process.env.DEBUG_ROUTES_ENABLED === 'true') {
  ```
- **Problem:** Setting `DEBUG_ROUTES_ENABLED=true` in production exposes debug endpoints (`/api/debug/*`) that leak user counts, socket status, presence data, user listings, and allow deleting users. Even though admin auth is required in production, this is a risky escape hatch.
- **Severity:** MEDIUM
- **Fix:** Remove the `DEBUG_ROUTES_ENABLED` backdoor entirely for production, or at minimum add a warning log when it's activated.

### 1.3 — `delete-fake-users` can delete real users

- **File:** `src/routes/debugRoutes.js` lines 79–97
- **Problem:** The deletion query uses loose regex patterns (`/test/i`, `/fake/i`, `/demo/i`) against email and username. Any real user whose email contains "test" (e.g. `contest@gmail.com`) or username contains "demo" would be deleted. No confirmation step. No soft-delete.
- **Severity:** HIGH
- **Fix:** Use much stricter patterns (e.g. exact `@guest.local` domain check, or the `isGuest` flag), or remove this endpoint.

### 1.4 — Mock checkout page has no authentication

- **File:** `src/routes/paymentRoutes.js` line 18
- **Code:** `router.get("/mock-checkout", paymentController.mockCheckout);`
- **Problem:** Anyone with a `providerPaymentId` can view payment details (amount, product, user info) without authentication.
- **Severity:** MEDIUM (mock provider only)
- **Fix:** Add auth middleware or restrict to non-production environments.

### 1.5 — Webhook endpoint has no signature verification for mock provider

- **File:** `src/routes/paymentRoutes.js` line 20 → `src/controllers/paymentController.js` → `src/services/paymentProviders/mockProvider.js`
- **Problem:** The mock provider's `verifyWebhook` always returns `true`. If mock provider is accidentally left active in production, anyone can mark payments as complete.
- **Severity:** HIGH (if mock provider used in production)
- **Fix:** Ensure `PAYMENT_PROVIDER` cannot default to "mock" in production. Add a hard check that blocks mock provider when `NODE_ENV === 'production'`.

### 1.6 — Guest login creates weak deterministic passwords

- **File:** `src/controllers/authController.js` line 312
- **Code:** `password: Math.random().toString(36).slice(-8)`
- **Problem:** `Math.random()` is not cryptographically secure. The generated 8-char base-36 password is weak.
- **Severity:** LOW (guests can't login with password, but it's stored in DB)
- **Fix:** Use `crypto.randomBytes(32).toString('hex')` or mark guest accounts as non-loginable.

### 1.7 — `GOOGLE_CLIENT_ID` not centralized in env.js

- **File:** `src/controllers/authController.js` line 11
- **Code:** `const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);`
- **Problem:** `GOOGLE_CLIENT_ID` is read directly from `process.env` instead of through `env.js`. The OAuth2Client is initialized at module load time with potentially `undefined` — no error until a user actually tries Google login.
- **Severity:** MEDIUM
- **Fix:** Add `GOOGLE_CLIENT_ID` to `config/env.js` exports, initialize OAuth2Client lazily or validate at startup.

### 1.8 — In-memory rate limiting not suitable for multi-instance production

- **File:** `src/middleware/rateLimit.js` (entire file, 206 lines)
- **Problem:** Rate limiting uses an in-memory `Map`. Each server instance has its own counter. With multiple instances behind a load balancer, an attacker can bypass limits by hitting different instances (100 req/min × N instances). The project already uses Redis adapter for Socket.io, so Redis is available.
- **Severity:** MEDIUM
- **Fix:** Use Redis-backed rate limiting (e.g. `rate-limiter-flexible` with Redis store).

### 1.9 — Maintenance mode admin bypass never works

- **File:** `src/middleware/maintenanceMiddleware.js` line 40
- **Code:** `if (req.user && req.user.role === "admin") { return next(); }`
- **Problem:** This middleware runs at the app level (before route-level `auth` middleware), so `req.user` is **always undefined** at this point. The admin bypass condition is dead code.
- **Severity:** MEDIUM
- **Fix:** Either parse the JWT token inside the maintenance middleware, or move the admin bypass logic to after the auth middleware runs.

### 1.10 — `/api/calls/active` exposes all active calls to any authenticated user

- **File:** `src/routes/callRoutes.js` lines 315–330
- **Problem:** Any authenticated user can see all active calls (room names, caller IDs, target user IDs, timestamps). This should be admin-only.
- **Severity:** MEDIUM
- **Fix:** Add `adminMiddleware` to this route.

### 1.11 — Excessive `console.log` with user data in production

- **Files:** `src/socket/connectionHandler.js`, `src/socket/chatHandlers.js`, `src/socket/callHandlers.js`, `src/controllers/userController.js`, and 15+ other files
- **Problem:** Over 50 `console.log` statements with user IDs, socket IDs, usernames, and message content in production. This bloats logs and can leak PII.
- **Severity:** LOW
- **Fix:** Replace with `logger.debug()` calls that are silenced in production.

### 1.12 — Static file serving exposes uploads directory

- **File:** `src/server.js` line 221
- **Code:** `app.use('/uploads', express.static(path.join(__dirname, '../uploads')));`
- **Problem:** All uploaded files (chat images, videos, audio) are publicly accessible without authentication by direct URL.
- **Severity:** MEDIUM
- **Fix:** Add auth middleware before the static serving, or use signed URLs.

---

## 2. Missing Error Handling

### 2.1 — Call initiation sets users busy before socket notification

- **File:** `src/routes/callRoutes.js` lines 60–67
- **Problem:** Both caller and target are set as "busy" via `presenceService.setBusy()` **before** the socket notification is sent. If the target user's socket is unreachable, both users are stuck in a "busy" state with no cleanup. The `CallHistory` record is created with status `missed` and may never be updated.
- **Severity:** HIGH
- **Fix:** Verify socket reachability first, or add a timeout cleanup that reverts busy state after N seconds if no call acceptance.

### 2.2 — `startBroadcast` updates DB but no rollback on failure

- **File:** `src/controllers/userController.js` lines 1281–1340
- **Problem:** The `User.findByIdAndUpdate` at line 1316 sets `isLive: true` and then `presenceService.setLive()` is called separately. If the presence service call fails, the DB shows the user as live but the presence system doesn't. No atomic transaction.
- **Severity:** MEDIUM
- **Fix:** Wrap in a try/catch that reverts the DB change on presence failure.

### 2.3 — `applyPaidEffects` session error handling

- **File:** `src/services/paymentService.js` lines 132–217
- **Problem:** The `session.endSession()` is in a `finally` block (good), but if `session.withTransaction()` throws, the error propagates up. The calling function (`processWebhook`) catches it, but the PaymentEvent is still logged as received. A failed `applyPaidEffects` could leave the payment in a limbo state between "pending" and "paid".
- **Severity:** MEDIUM
- **Fix:** Add retry logic or a status like "processing_failed" for payments where `applyPaidEffects` throws.

### 2.4 — Missing error responses in some inline route handlers

- **Files:** `src/routes/callRoutes.js`, `src/routes/reportRoutes.js`, `src/routes/statsRoutes.js`, `src/routes/settingsRoutes.js`
- **Problem:** Several catch blocks return `{ success: false, message: error.message }` which in production leaks internal error messages to the client (e.g. Mongoose validation errors, DB connection details).
- **Severity:** LOW
- **Fix:** Return generic "Server error" messages and log the actual error.

---

## 3. Incomplete Implementations

### 3.1 — `src/chat/` directory is empty

- **Path:** `src/chat/` (empty directory)
- **Problem:** Appears to be a leftover from a planned or refactored chat module. The actual chat logic is in `src/services/chatService.js` and `src/socket/chatHandlers.js`.
- **Fix:** Delete the empty directory.

### 3.2 — `src/live/` directory is empty

- **Path:** `src/live/` (empty directory)
- **Problem:** Same as above. Live logic is in `src/services/liveService.js` and `src/socket/liveHandlers.js`.
- **Fix:** Delete the empty directory.

### 3.3 — Translation service uses unofficial Google API

- **File:** `src/services/translationService.js`
- **Problem:** Uses `https://translate.googleapis.com/translate_a/single?client=gtx` — this is an undocumented, unofficial endpoint. Google can rate-limit, block, or change it at any time without notice. Not suitable for production.
- **Severity:** MEDIUM
- **Fix:** Use the official Google Cloud Translation API (paid), or a proper translation library.

### 3.4 — CDN utilities reference env vars not in env.js

- **File:** `src/utils/cdn.js` lines 12–13
- **Code:** `process.env.CDN_BASE_URL`, `process.env.CDN_ENABLED`
- **Problem:** These environment variables are read directly from `process.env` instead of going through `env.js`. They're also not documented anywhere.
- **Severity:** LOW
- **Fix:** Add to `config/env.js` for consistency.

### 3.5 — No TODO/FIXME/HACK comments found

- **Finding:** A grep for `TODO|FIXME|HACK` across all source files returned zero results. This is positive — no acknowledged incomplete work.

---

## 4. Missing Environment Variables / Config Issues

### 4.1 — `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` default to empty string

- **File:** `src/config/env.js` lines 59–60
- **Code:**
  ```js
  LIVEKIT_API_KEY: required("LIVEKIT_API_KEY", ""),
  LIVEKIT_API_SECRET: required("LIVEKIT_API_SECRET", ""),
  ```
- **Problem:** In development, these default to `""`. The `liveService.js` will throw confusing errors when generating tokens because the LiveKit SDK receives empty credentials.
- **Severity:** MEDIUM
- **Fix:** Either throw a clear error when these are empty and a LiveKit feature is used, or use meaningful placeholder values that produce a clear error.

### 4.2 — `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` default to empty string

- **File:** `src/config/env.js` lines 67–68
- **Problem:** Same pattern — empty defaults. The Stripe provider does have a check at the top (`stripeProvider.js` line 9) that throws if `STRIPE_SECRET_KEY` is missing, but only at request time.
- **Severity:** LOW (dev only, stripe provider must be explicitly selected)

### 4.3 — `REVENUECAT_API_KEY` defaults to empty string

- **File:** `src/config/env.js` line 72
- **Problem:** IAP verification will silently fail with invalid API requests.
- **Severity:** LOW

### 4.4 — Currency mismatch: Payment model defaults to TRY, catalog uses USD

- **File:** `src/models/Payment.js` line 16 → `currency: { type: String, required: true, default: "TRY" }`
- **File:** `src/config/paymentCatalog.js` → all products use `currency: "USD"`
- **Problem:** The Payment model's default currency is `"TRY"` but the catalog exclusively uses `"USD"`. If a payment is created without explicitly setting currency, it will be recorded as TRY.
- **Severity:** MEDIUM
- **Fix:** Change the Payment model default to `"USD"` to match the catalog, or remove the default entirely.

### 4.5 — `JWT_SECRET` dev fallback is predictable

- **File:** `src/config/env.js` line 51
- **Code:** `const devFallback = "dev_only_change_this_secret";`
- **Problem:** If `.env` file is missing/misconfigured, all JWTs in development use this well-known secret. Anyone who reads the source code can forge tokens.
- **Severity:** LOW (dev only, production throws)

### 4.6 — Missing env vars accessed via `process.env` directly

The following environment variables are accessed directly from `process.env` instead of being centralized in `config/env.js`:

| Variable | File | Line |
|---|---|---|
| `GOOGLE_CLIENT_ID` | `src/controllers/authController.js` | 11, 370, 387 |
| `CDN_BASE_URL` | `src/utils/cdn.js` | 12 |
| `CDN_ENABLED` | `src/utils/cdn.js` | 13 |
| `REDIS_HOST` | `src/server.js` | 127 |
| `REDIS_PORT` | `src/server.js` | 128 |
| `REDIS_PASSWORD` | `src/server.js` | 129 |
| `TRUST_PROXY` | `src/server.js` | 183 |
| `ALLOW_PUBLIC_DEBUG_ROUTES` | `src/server.js` | 270 |
| `DEBUG_ROUTES_ENABLED` | `src/server.js` | 267 |

**Fix:** Centralize all env var access through `config/env.js`.

---

## 5. Unused / Dead Code

### 5.1 — Empty directories

| Path | Status |
|---|---|
| `src/chat/` | Empty, unused |
| `src/live/` | Empty, unused |

### 5.2 — `src/config/firebase.js` (shim file)

- **Problem:** Kept "for backward compatibility" but appears unused. All Firebase functionality goes through `firebaseAdmin.js`.
- **Fix:** Verify no imports reference it, then delete.

### 5.3 — Maintenance middleware admin bypass (dead code)

- **File:** `src/middleware/maintenanceMiddleware.js` line 40
- **Code:** `if (req.user && req.user.role === "admin") { return next(); }`
- **Problem:** `req.user` is always undefined at this middleware stage. This code path is unreachable.
- (Also listed under Security Issues §1.9)

### 5.4 — `redis` npm package potentially unused

- **File:** `package.json` line 41 → `"redis": "^5.10.0"`
- **Problem:** The codebase uses `ioredis` for all Redis operations (`config/redis.js`, Socket.io adapter). The `redis` (node-redis) package may be unused. Verify and remove if so.
- **Fix:** Search for `require('redis')` across all files. If not found, remove from dependencies.

---

## 6. Missing Validations

### 6.1 — Gift validator / controller field name mismatch (CRITICAL BUG)

- **File:** `src/middleware/validate.js` line 138 → validates `body('receiverId')`
- **File:** `src/controllers/giftController.js` line 29 → destructures `const { giftId, liveId, roomId, recipientId } = req.body;`
- **Problem:** The validator checks and sanitizes `receiverId`, but the controller reads `recipientId`. The validation is **completely bypassed** because the validated field name doesn't match what the controller uses. An attacker could send arbitrary `recipientId` values.
- **Severity:** HIGH
- **Fix:** Align the field names. Either the validator should check `recipientId` or the controller should read `receiverId`.

### 6.2 — Call routes: minimal input validation

- **File:** `src/routes/callRoutes.js` (all inline handlers)
- **Problem:** The `targetUserId` in `/initiate` is only checked for existence (`!targetUserId`), not that it's a valid MongoDB ObjectId. The `roomName` in `/answer`, `/reject`, `/end`, `/token` is not validated against format. The `userName` parameter in `/token` is used directly.
- **Severity:** MEDIUM
- **Fix:** Add `validateMongoId` middleware for user IDs, validate room name format.

### 6.3 — Settings routes: no input validation

- **File:** `src/routes/settingsRoutes.js`
- **Problem:** The `PUT /api/settings` endpoint accepts arbitrary JSON to update system settings (maintenance mode, VIP prices, commission rates, etc.) with no schema validation. A malformed value (e.g. `commissionRate: "abc"`) would be saved directly.
- **Severity:** MEDIUM
- **Fix:** Add express-validator rules for each setting field.

### 6.4 — Withdrawal IBAN validation missing

- **File:** `src/controllers/withdrawalController.js`
- **Problem:** Users submit bank details (IBAN, account holder name) for withdrawals. There's no IBAN format validation — invalid IBANs are accepted and would fail during actual bank transfer.
- **Severity:** MEDIUM
- **Fix:** Add IBAN checksum validation (or use a library like `ibantools`).

### 6.5 — File upload: no extension whitelist

- **File:** `src/controllers/chatController.js` lines 275–289
- **Code:** `const ext = path.extname(file.originalname);`
- **Problem:** The extension is extracted from `originalname` without any whitelist check. While multer uses `memoryStorage` (buffer-based), the file is then written to disk with the user-controlled extension. Potentially dangerous extensions (`.exe`, `.html`, `.svg` with scripts) could be served via the static `/uploads` route.
- **Severity:** MEDIUM
- **Fix:** Add an allowed-extensions whitelist (e.g. `.jpg`, `.png`, `.mp4`, `.mp3`, `.webp`).

---

## 7. Broken Imports or Require Statements

### 7.1 — `require('debug')` — module not installed

- **File:** `src/server.js` line 141
- **Impact:** Server crash in development mode.
- (Also listed under Security Issues §1.1)

### 7.2 — `stripe` npm package NOT in dependencies

- **File:** `src/services/paymentProviders/stripeProvider.js`
- **Finding:** The Stripe provider does **NOT** use the `stripe` npm package. It makes raw HTTP calls via `axios` to `https://api.stripe.com/v1`. This is intentional but unconventional.
- **Impact:** Not a broken import. However, this means no Stripe SDK signature verification is available, the developer must manually implement webhook signature checking.

### 7.3 — No broken require() statements found

All other `require()` calls across the codebase reference modules that exist in `node_modules` (per `package.json`) or local files that exist on disk. This was verified by tracing all imports.

---

## 8. Payment System Completeness

### 8.1 — Overall Assessment: ~85% Complete

The payment system has a solid architecture with provider abstraction, idempotency, MongoDB transactions, and event logging. Key gaps:

### 8.2 — PaymentEvent provider enum missing "revenuecat"

- **File:** `src/models/PaymentEvent.js` line 6
- **Code:** `provider: { type: String, enum: ["mock", "stripe"], required: true, index: true }`
- **Problem:** The `Payment` model allows `"revenuecat"` as a provider, but `PaymentEvent` does not. IAP webhook events from RevenueCat will fail Mongoose validation and won't be logged.
- **Severity:** HIGH
- **Fix:** Add `"revenuecat"` to the enum array.

### 8.3 — Stripe webhook signature verification is manual

- **File:** `src/services/paymentProviders/stripeProvider.js`
- **Problem:** The provider uses raw `axios` calls instead of the Stripe SDK. Webhook signature verification (which Stripe strongly recommends) would need to be manually implemented using HMAC-SHA256. The current code structure doesn't show a `verifyWebhook` method that checks Stripe signatures.
- **Severity:** HIGH for production
- **Fix:** Either use the `stripe` npm package for webhook verification, or implement manual `Stripe-Signature` header validation.

### 8.4 — No retry/dead-letter for failed webhook processing

- **Problem:** If `processWebhook` fails after logging the `PaymentEvent`, the payment stays in "pending" state. There's no cron job or retry mechanism to reprocess stuck payments.
- **Severity:** MEDIUM
- **Fix:** Add a periodic job that checks for payments in "pending" state older than N minutes and retries or alerts.

### 8.5 — Mock provider accessible without env guard

- **File:** `src/config/env.js` line 63
- **Code:** `PAYMENT_PROVIDER: required("PAYMENT_PROVIDER", "mock")`
- **Problem:** If `PAYMENT_PROVIDER` is not set, it defaults to `"mock"` even in production. Combined with the webhook having no real signature check for mock, this is a critical production risk.
- **Severity:** HIGH
- **Fix:** In production, either throw if `PAYMENT_PROVIDER` is `"mock"`, or require it to be explicitly set.

### 8.6 — Features that ARE complete

- Payment intent creation with catalog validation
- IAP purchase verification via RevenueCat
- Idempotent payment creation (orderId check)
- MongoDB transactions for coin/VIP crediting (`applyPaidEffects`)
- Refund support (mock + stripe)
- Admin payment stats and listing endpoints
- Payment event audit trail (`PaymentEvent` model)
- Payment history for users

---

## 9. Database Connection Issues

### 9.1 — `process.exit(1)` on connection failure

- **File:** `src/config/db.js`
- **Problem:** If MongoDB is unreachable on startup, the process exits. This is standard but means the server has no retry logic for initial connection. In container orchestration (Kubernetes, Docker), the container will restart, which is acceptable.
- **Severity:** LOW

### 9.2 — MongoDB transactions require replica set

- **File:** `src/services/paymentService.js` line 134
- **Code:** `const session = await Payment.startSession(); await session.withTransaction(...)`
- **Problem:** MongoDB transactions (`startSession` + `withTransaction`) require a replica set or sharded cluster. A standalone MongoDB instance (common in development with `mongodb://127.0.0.1:27017/eyra`) will throw: `"Transaction numbers are only allowed on a replica set member or mongos"`.
- **Severity:** HIGH in development, N/A if production uses Atlas/replica set
- **Fix:** Document the replica set requirement. For development, use `mongod --replSet rs0` or MongoDB Atlas free tier. Consider a fallback non-transactional code path for development.

### 9.3 — Startup mass-update resets all users offline

- **File:** `src/server.js` lines ~409–421
- **Problem:** On every server start, ALL users are set to `isOnline: false, isLive: false, presenceStatus: 'offline'`. In a multi-instance deployment, one instance restarting would mark all users offline, affecting users connected to other instances.
- **Severity:** HIGH in multi-instance deployments
- **Fix:** Only reset users that were tracked by this specific instance, or use the presence service (in-memory/Redis) as the source of truth and skip the mass DB update.

### 9.4 — No connection pooling configuration

- **File:** `src/config/db.js`
- **Problem:** The `mongoose.connect()` call doesn't specify `maxPoolSize`, `minPoolSize`, or other connection pool settings. Mongoose defaults to `maxPoolSize: 100` which may be too high for some deployments.
- **Severity:** LOW
- **Fix:** Add explicit pool configuration based on expected load.

---

## 10. Missing API Endpoints / Architecture Issues

### 10.1 — No controller files for 4 route groups

The project follows a routes → controller → service pattern for most features, but these route files have **all business logic inline**:

| Route File | Lines | Missing Controller |
|---|---|---|
| `src/routes/callRoutes.js` | 388 | `callController.js` |
| `src/routes/reportRoutes.js` | 209 | `reportController.js` |
| `src/routes/statsRoutes.js` | ~150 | `statsController.js` |
| `src/routes/settingsRoutes.js` | ~100 | `settingsController.js` |

**Problem:** Violates the project's own architecture pattern. Makes testing harder and business logic harder to reuse.

### 10.2 — Heavy global state usage

- **File:** `src/server.js` lines 148–151
- **Globals:** `global.io`, `global.userSockets`, `global.activeCalls`, `global.pendingCalls`
- **Problem:** Used throughout controllers and route handlers. Makes the code tightly coupled to a single-process model and harder to test.
- **Severity:** LOW (functional, but architectural debt)

### 10.3 — `cookie-parser` in dependencies but no cookie usage visible

- **File:** `package.json` → `"cookie-parser": "^1.4.7"`
- **Problem:** The auth middleware checks for `req.cookies?.token` as a fallback, so it IS used. However, no endpoint sets cookies. The Flutter mobile app uses Bearer tokens. Cookie support appears to be dead code.
- **Severity:** LOW

### 10.4 — `moment` dependency (heavy)

- **File:** `package.json` → `"moment": "^2.30.1"`
- **Problem:** `moment.js` is 300KB+ and in maintenance mode. The project could use native `Date` or `dayjs` (2KB).
- **Severity:** LOW (performance, not correctness)

---

## Summary of Critical / High Severity Issues

| # | Issue | File | Severity |
|---|---|---|---|
| 1.1 | `debug` package not installed — dev crash | `server.js:141` | HIGH |
| 1.3 | `delete-fake-users` can delete real users | `debugRoutes.js:79` | HIGH |
| 1.5 | Mock webhook has no real verification | `mockProvider.js` | HIGH* |
| 1.9 | Maintenance mode admin bypass is dead code | `maintenanceMiddleware.js:40` | MEDIUM |
| 2.1 | Users stuck busy if socket notify fails | `callRoutes.js:60` | HIGH |
| 6.1 | Gift validator/controller field mismatch | `validate.js:138` / `giftController.js:29` | HIGH |
| 8.2 | PaymentEvent missing "revenuecat" provider | `PaymentEvent.js:6` | HIGH |
| 8.3 | No Stripe webhook signature verification | `stripeProvider.js` | HIGH |
| 8.5 | Mock provider default in production | `env.js:63` | HIGH |
| 9.2 | Transactions require replica set | `paymentService.js:134` | HIGH |
| 9.3 | Startup resets all users offline | `server.js:~409` | HIGH |

*\* Only if mock provider is active in production*

---

## Recommendations (Priority Order)

1. **Fix the `receiverId`/`recipientId` mismatch** — this is an active bug causing gift validation to be bypassed
2. **Add `"revenuecat"` to PaymentEvent provider enum** — IAP events are silently failing
3. **Install `debug` package or remove the require** — prevents dev environment crashes
4. **Block mock payment provider in production** — add `if (NODE_ENV === 'production' && PAYMENT_PROVIDER === 'mock') throw`
5. **Implement Stripe webhook signature verification** — required before going live with payments
6. **Fix the maintenance middleware admin bypass** — parse JWT in middleware or restructure
7. **Add timeout/cleanup for busy call states** — prevent users from getting permanently stuck
8. **Scope the startup user-reset to current instance** — required for multi-instance deployment
9. **Replace `console.log` with `logger.debug`** — reduce log noise and PII exposure
10. **Extract inline route handlers into controllers** — callRoutes, reportRoutes, statsRoutes, settingsRoutes
