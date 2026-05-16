// src/middleware/rateLimit.js

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { logger } = require("../utils/logger");

/**
 * Simple in-memory rate limiter for API endpoints
 * For production, consider using Redis-based rate limiting
 */

const rateLimitStore = new Map();

const normalizeText = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

const getClientIp = (req) => {
  // ⚠️ X-Forwarded-For is only trusted when the app is behind a known reverse
  // proxy (Render, Heroku, nginx). We take the LAST IP added by the trusted
  // proxy (rightmost non-private entry) to prevent header spoofing.
  // If the request has already had req.ip set by Express trust proxy, use that.
  if (req.ip && req.ip !== "::1" && req.ip !== "127.0.0.1") {
    return req.ip;
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    // Take the last (rightmost) IP — added by the trusted proxy, not the client.
    const ips = forwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ips.length > 0) return ips[ips.length - 1];
  }

  return req.connection?.remoteAddress || "unknown";
};

/**
 * Best-effort userId extraction from JWT for rate-limit keying.
 * Verifies signature when JWT_SECRET is available; falls back to a safe
 * unverified decode if the token cannot be verified. Returned id is only
 * used as a bucket key — real authorization still happens per route.
 */
const extractUserIdForRateLimit = (req) => {
  if (req.user?.id) return String(req.user.id);

  const auth = req.headers?.authorization;
  if (typeof auth !== "string") return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  try {
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const decoded = jwt.verify(token, secret, { ignoreExpiration: true });
      const id = decoded?.id || decoded?.userId || decoded?._id || decoded?.sub;
      if (id) return String(id);
    }
  } catch (_) {
    // fall through to unverified decode
  }

  try {
    const decoded = jwt.decode(token);
    const id = decoded?.id || decoded?.userId || decoded?._id || decoded?.sub;
    if (id) return String(id);
  } catch (_) {
    // ignore
  }
  return null;
};

const sanitizePathPart = (value) =>
  String(value || "unknown")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_") || "root";

const getAuthRequestSubject = (req) => {
  if (!req.body || typeof req.body !== "object") {
    return "";
  }

  return normalizeText(
    req.body.email ||
      req.body.phone ||
      req.body.phoneNumber ||
      req.body.username ||
      req.body.uid ||
      req.body.firebaseUid,
  );
};

const attachSuccessfulResponseHandler = ({
  key,
  res,
  skipSuccessfulRequests,
}) => {
  if (!skipSuccessfulRequests) {
    return;
  }

  const originalSend = res.send;
  res.send = function (body) {
    if (res.statusCode < 400) {
      const currentData = rateLimitStore.get(key);
      if (currentData && currentData.count > 0) {
        currentData.count--;
        rateLimitStore.set(key, currentData);
      }
    }
    return originalSend.call(this, body);
  };
};

const resolveRateLimitKey = ({ keyGenerator, req, context }) => {
  if (typeof keyGenerator !== "function") {
    return {
      key: `${context.keyPrefix}:${context.userId || context.ip}`,
      scope: context.userId ? "user" : "ip",
    };
  }

  const generated = keyGenerator(req, context);
  if (typeof generated === "string" && generated) {
    return { key: generated, scope: null };
  }

  if (
    generated &&
    typeof generated === "object" &&
    typeof generated.key === "string" &&
    generated.key
  ) {
    return {
      key: generated.key,
      scope: generated.scope || null,
    };
  }

  return {
    key: `${context.keyPrefix}:${context.userId || context.ip}`,
    scope: context.userId ? "user" : "ip",
  };
};

// Cleanup old entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, data] of rateLimitStore.entries()) {
      if (now - data.windowStart > data.windowMs * 2) {
        rateLimitStore.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window
 * @param {string} options.message - Error message
 * @param {string} options.keyPrefix - Key prefix for different limiters
 * @param {boolean} options.skipSuccessfulRequests - Don't count successful requests
 * @param {(req: import('express').Request, context: object) => string | { key: string, scope?: string }} options.keyGenerator - Custom key generator
 * @param {(req: import('express').Request) => boolean} options.skip - Skip limiter for matching requests
 */
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 60 * 1000, // 1 minute default
    max = 100,
    message = "Çok fazla istek gönderdiniz. Lütfen bekleyin.",
    keyPrefix = "rl",
    skipSuccessfulRequests = false,
    keyGenerator = null,
    skip = null,
    skipRoles = ["admin", "super_admin"],
  } = options;

  return (req, res, next) => {
    if (typeof skip === "function" && skip(req)) {
      return next();
    }

    // Admin ve super_admin rate limit'ten muaf
    const userRole = String(req.user?.role || "")
      .trim()
      .toLowerCase();
    if (Array.isArray(skipRoles) && skipRoles.includes(userRole)) {
      return next();
    }

    // Get identifier (userId if authenticated, IP otherwise)
    // NOTE: This middleware can run BEFORE per-route auth, so try to derive
    // userId from the JWT directly. This prevents all users behind a single
    // NAT/CGNAT IP from sharing the same bucket.
    const userId = extractUserIdForRateLimit(req);
    const ip = getClientIp(req);
    const context = {
      keyPrefix,
      userId,
      ip,
      path: req.path,
      originalUrl: req.originalUrl || req.path,
      method: req.method,
    };
    const { key, scope } = resolveRateLimitKey({
      keyGenerator,
      req,
      context,
    });
    const now = Date.now();

    // Resolve effective limit (allow `max` to be a function of req/context)
    let effectiveMax = max;
    if (typeof max === "function") {
      try {
        effectiveMax = max(req, context);
      } catch (_) {
        effectiveMax = 100;
      }
    }
    if (typeof effectiveMax !== "number" || effectiveMax <= 0) {
      effectiveMax = 100;
    }

    let data = rateLimitStore.get(key);

    if (!data || now - data.windowStart > windowMs) {
      // New window
      data = {
        count: 1,
        windowStart: now,
        windowMs,
      };
      rateLimitStore.set(key, data);

      // Set rate limit headers
      res.setHeader("X-RateLimit-Limit", effectiveMax);
      res.setHeader("X-RateLimit-Remaining", effectiveMax - 1);
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + windowMs) / 1000));

      attachSuccessfulResponseHandler({
        key,
        res,
        skipSuccessfulRequests,
      });

      return next();
    }

    if (data.count >= effectiveMax) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((data.windowStart + windowMs - now) / 1000);

      res.setHeader("X-RateLimit-Limit", effectiveMax);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil((data.windowStart + windowMs) / 1000),
      );
      res.setHeader("Retry-After", retryAfter);

      logger.warn("Rate limit exceeded", {
        keyPrefix,
        keyHash: hashValue(key),
        scope,
        method: req.method,
        path: req.originalUrl || req.path,
        userId: userId || null,
        ip,
        limit: effectiveMax,
        windowMs,
        currentCount: data.count,
        retryAfter,
      });

      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        message,
        retryAfter,
      });
    }

    // Increment count
    data.count++;
    rateLimitStore.set(key, data);

    res.setHeader("X-RateLimit-Limit", effectiveMax);
    res.setHeader("X-RateLimit-Remaining", effectiveMax - data.count);
    res.setHeader(
      "X-RateLimit-Reset",
      Math.ceil((data.windowStart + windowMs) / 1000),
    );

    attachSuccessfulResponseHandler({
      key,
      res,
      skipSuccessfulRequests,
    });

    next();
  };
};

// ============ PRE-CONFIGURED LIMITERS ============

/**
 * General API rate limiter
 * Authenticated user: 240 requests / minute
 * Anonymous (IP-only): 100 requests / minute
 *
 * NOTE: This limiter is mounted before per-route auth, so userId is derived
 * from the bearer JWT directly. Health checks are excluded.
 */
const generalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: (req, ctx) => (ctx.userId ? 240 : 100),
  message: "Çok fazla istek gönderdiniz. Lütfen bekleyin.",
  keyPrefix: "general",
  skip: (req) => req.method === "GET" && req.path.startsWith("/gifts"),
});

/**
 * Auth endpoints rate limiter (strict)
 * 5 requests per 5 minutes — brute-force koruması
 */
const authLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: "Çok fazla giriş denemesi. Lütfen 5 dakika bekleyin.",
  keyPrefix: "auth",
  skipSuccessfulRequests: true,
  keyGenerator: (req, context) => {
    const routeKey = sanitizePathPart(req.path);

    if (context.userId) {
      return {
        key: `${context.keyPrefix}:${routeKey}:user:${context.userId}`,
        scope: `route:${routeKey}:user`,
      };
    }

    const authSubject = getAuthRequestSubject(req);
    if (authSubject) {
      const subjectHash = hashValue(authSubject);
      return {
        key: `${context.keyPrefix}:${routeKey}:subject:${subjectHash}:ip:${context.ip}`,
        scope: `route:${routeKey}:subject`,
      };
    }

    return {
      key: `${context.keyPrefix}:${routeKey}:ip:${context.ip}`,
      scope: `route:${routeKey}:ip`,
    };
  },
});

/**
 * Chat message rate limiter
 * 30 messages per minute
 */
const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Çok hızlı mesaj gönderiyorsunuz. Lütfen yavaşlayın.",
  keyPrefix: "chat",
});

/**
 * Gift send rate limiter
 * 20 gifts per minute
 */
const giftLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Çok hızlı hediye gönderiyorsunuz. Lütfen bekleyin.",
  keyPrefix: "gift",
});

/**
 * Live stream start rate limiter
 * 5 attempts per 5 minutes
 */
const liveStartLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: "Çok fazla yayın başlatma denemesi. Lütfen 5 dakika bekleyin.",
  keyPrefix: "live_start",
});

/**
 * Report/Flag rate limiter
 * 10 reports per hour
 */
const reportLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Çok fazla şikayet gönderdiniz. Lütfen 1 saat bekleyin.",
  keyPrefix: "report",
});

/**
 * Panel admin rate limiter (very relaxed)
 * 500 requests per minute — panel many parallel API calls
 */
const panelAdminLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 500,
  message: "Çok fazla istek. Lütfen bekleyin.",
  keyPrefix: "panel_admin",
  skipRoles: [],
});

/**
 * Payment intent rate limiter
 * 10 payment intents per 5 minutes
 */
const paymentLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: "Çok fazla ödeme denemesi. Lütfen 5 dakika bekleyin.",
  keyPrefix: "payment",
});

/**
 * File upload rate limiter (avatar, profile photo, verification photos)
 * 10 uploads per 10 minutes per user
 */
const uploadLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: "Çok fazla dosya yükleme denemesi. Lütfen 10 dakika bekleyin.",
  keyPrefix: "upload",
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
  chatLimiter,
  giftLimiter,
  liveStartLimiter,
  reportLimiter,
  panelAdminLimiter,
  paymentLimiter,
  uploadLimiter,
};
