// src/middleware/rateLimit.js

/**
 * Simple in-memory rate limiter for API endpoints
 * For production, consider using Redis-based rate limiting
 */

const rateLimitStore = new Map();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > data.windowMs * 2) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window
 * @param {string} options.message - Error message
 * @param {string} options.keyPrefix - Key prefix for different limiters
 * @param {boolean} options.skipSuccessfulRequests - Don't count successful requests
 */
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 60 * 1000, // 1 minute default
    max = 100,
    message = "Çok fazla istek gönderdiniz. Lütfen bekleyin.",
    keyPrefix = "rl",
    skipSuccessfulRequests = false
  } = options;

  return (req, res, next) => {
    // Get identifier (userId if authenticated, IP otherwise)
    const userId = req.user?.id;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const identifier = userId || ip;
    
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();

    let data = rateLimitStore.get(key);

    if (!data || now - data.windowStart > windowMs) {
      // New window
      data = {
        count: 1,
        windowStart: now,
        windowMs
      };
      rateLimitStore.set(key, data);
      
      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', max - 1);
      res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));
      
      return next();
    }

    if (data.count >= max) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((data.windowStart + windowMs - now) / 1000);
      
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil((data.windowStart + windowMs) / 1000));
      res.setHeader('Retry-After', retryAfter);
      
      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message,
        retryAfter
      });
    }

    // Increment count
    data.count++;
    rateLimitStore.set(key, data);
    
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - data.count);
    res.setHeader('X-RateLimit-Reset', Math.ceil((data.windowStart + windowMs) / 1000));

    // Handle skipSuccessfulRequests
    if (skipSuccessfulRequests) {
      const originalSend = res.send;
      res.send = function(body) {
        if (res.statusCode < 400) {
          // Decrement count for successful requests
          const currentData = rateLimitStore.get(key);
          if (currentData && currentData.count > 0) {
            currentData.count--;
            rateLimitStore.set(key, currentData);
          }
        }
        return originalSend.call(this, body);
      };
    }

    next();
  };
};

// ============ PRE-CONFIGURED LIMITERS ============

/**
 * General API rate limiter
 * 100 requests per minute
 */
const generalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 100,
  message: "Çok fazla istek gönderdiniz. Lütfen bekleyin.",
  keyPrefix: "general"
});

/**
 * Auth endpoints rate limiter (stricter)
 * 10 requests per minute
 */
const authLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: "Çok fazla giriş denemesi. Lütfen 1 dakika bekleyin.",
  keyPrefix: "auth"
});

/**
 * Chat message rate limiter
 * 30 messages per minute
 */
const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Çok hızlı mesaj gönderiyorsunuz. Lütfen yavaşlayın.",
  keyPrefix: "chat"
});

/**
 * Gift send rate limiter
 * 20 gifts per minute
 */
const giftLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Çok hızlı hediye gönderiyorsunuz. Lütfen bekleyin.",
  keyPrefix: "gift"
});

/**
 * Live stream start rate limiter
 * 5 attempts per 5 minutes
 */
const liveStartLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: "Çok fazla yayın başlatma denemesi. Lütfen 5 dakika bekleyin.",
  keyPrefix: "live_start"
});

/**
 * Report/Flag rate limiter
 * 10 reports per hour
 */
const reportLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Çok fazla şikayet gönderdiniz. Lütfen 1 saat bekleyin.",
  keyPrefix: "report"
});

module.exports = {
  createRateLimiter,
  generalLimiter,
  authLimiter,
  chatLimiter,
  giftLimiter,
  liveStartLimiter,
  reportLimiter
};
