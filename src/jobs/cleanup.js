/**
 * Periodic cleanup jobs: stale calls, stale live streams, expired VIP.
 * Call startAll(io) once after server is ready. Returns timer refs for shutdown.
 */

const {
  activeCalls,
  pendingCalls,
  socketGenderCache,
  userConnectionTimestamps,
} = require('../socket/state');
const User = require('../models/User');
const LiveStream = require('../models/LiveStream');
const liveService = require('../services/liveService');
const { logger } = require('../utils/logger');

// ---- Constants ----
const STALE_CALL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const STALE_PENDING_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_LIVE_OFFLINE_GRACE_MS = 30 * 1000; // 30 seconds

// ---- Stale call cleanup ----
function cleanupStaleCalls(io) {
  const now = Date.now();
  let cleanedCalls = 0;
  let cleanedPending = 0;

  for (const [roomName, callInfo] of activeCalls.entries()) {
    const createdAt =
      callInfo.createdAt instanceof Date
        ? callInfo.createdAt.getTime()
        : typeof callInfo.createdAt === 'number'
          ? callInfo.createdAt
          : 0;

    if (now - createdAt > STALE_CALL_TIMEOUT_MS) {
      activeCalls.delete(roomName);
      cleanedCalls++;
      console.log(
        `🧹 Stale call cleaned: ${roomName} (created ${Math.round((now - createdAt) / 60000)} minutes ago)`,
      );
    }
  }

  for (const [userId, calls] of pendingCalls.entries()) {
    if (!Array.isArray(calls)) {
      pendingCalls.delete(userId);
      continue;
    }

    const freshCalls = calls.filter((call) => {
      const createdAt =
        call.createdAt instanceof Date
          ? call.createdAt.getTime()
          : typeof call.createdAt === 'number'
            ? call.createdAt
            : 0;
      return now - createdAt < STALE_PENDING_CALL_TIMEOUT_MS;
    });

    if (freshCalls.length === 0) {
      pendingCalls.delete(userId);
      cleanedPending += calls.length;
    } else if (freshCalls.length < calls.length) {
      pendingCalls.set(userId, freshCalls);
      cleanedPending += calls.length - freshCalls.length;
    }
  }

  // Cache cleanup: remove entries for disconnected sockets
  let cleanedCacheEntries = 0;
  for (const [socketId] of socketGenderCache.entries()) {
    if (!io.sockets.sockets.has(socketId)) {
      socketGenderCache.delete(socketId);
      cleanedCacheEntries++;
    }
  }

  // Rate limit cleanup: remove old timestamps (>5 min)
  let cleanedRateLimitEntries = 0;
  const rateLimitMaxAge = 5 * 60 * 1000;
  for (const [userId, timestamp] of userConnectionTimestamps.entries()) {
    if (now - timestamp > rateLimitMaxAge) {
      userConnectionTimestamps.delete(userId);
      cleanedRateLimitEntries++;
    }
  }

  if (cleanedCalls > 0 || cleanedPending > 0 || cleanedCacheEntries > 0 || cleanedRateLimitEntries > 0) {
    console.log(
      `🧹 Stale cleanup: ${cleanedCalls} calls, ${cleanedPending} pending, ${cleanedCacheEntries} cache, ${cleanedRateLimitEntries} rate-limit entries removed`,
    );
  }
}

// ---- Stale live stream cleanup ----
async function cleanupStaleLiveStreams(closeActiveLiveStreamsForHost) {
  try {
    const cutoff = new Date(Date.now() - STALE_LIVE_OFFLINE_GRACE_MS);

    const stale = await LiveStream.find({ isLive: true, status: 'live' })
      .populate('host', 'isOnline lastOfflineAt isActive isBanned')
      .select('_id roomId host viewerCount duration totalGiftsValue peakViewerCount')
      .limit(500);

    let closed = 0;
    for (const s of stale) {
      const host = s.host;
      const hostOfflineLongEnough = host?.lastOfflineAt && host.lastOfflineAt <= cutoff;
      const shouldClose =
        !host || host.isOnline !== true || host.isActive === false || host.isBanned === true;

      if (!host && shouldClose) {
        await closeActiveLiveStreamsForHost(s.host, 'stale_cleanup_orphan');
        closed++;
        continue;
      }

      if (shouldClose && hostOfflineLongEnough) {
        await closeActiveLiveStreamsForHost(host?._id || s.host, 'stale_cleanup');
        closed++;
      }
    }

    if (closed > 0) {
      console.log(`🧹 Stale live cleanup: ${closed} streams auto-ended`);
    }
  } catch (e) {
    logger.warn(`⚠️ cleanupStaleLiveStreams failed: ${e.message}`);
  }
}

// ---- VIP expiry cleanup ----
async function cleanupExpiredVip() {
  try {
    const now = new Date();
    const result = await User.updateMany(
      { isVip: true, vipExpiresAt: { $lte: now } },
      { $set: { isVip: false, vipTier: 'none' } },
    );
    if (result.modifiedCount > 0) {
      console.log(`🧹 VIP expiry cleanup: ${result.modifiedCount} VIP üyelik sona erdi`);
    }
  } catch (e) {
    logger.warn(`⚠️ cleanupExpiredVip failed: ${e.message}`);
  }
}

/**
 * Start all periodic cleanup jobs.
 * @param {Server} io - Socket.io server instance
 * @param {Function} closeActiveLiveStreamsForHost - From presenceSync module
 * @returns {{ staleCleanupTimer, staleLiveCleanupTimer, vipExpiryTimer }} Timer refs for shutdown
 */
function startAll(io, closeActiveLiveStreamsForHost) {
  const staleCleanupTimer = setInterval(() => cleanupStaleCalls(io), 5 * 60 * 1000);
  const staleLiveCleanupTimer = setInterval(
    () => cleanupStaleLiveStreams(closeActiveLiveStreamsForHost),
    2 * 60 * 1000,
  );
  const vipExpiryTimer = setInterval(cleanupExpiredVip, 10 * 60 * 1000);

  // Don't keep process alive just for timers
  if (typeof staleCleanupTimer.unref === 'function') staleCleanupTimer.unref();
  if (typeof staleLiveCleanupTimer.unref === 'function') staleLiveCleanupTimer.unref();
  if (typeof vipExpiryTimer.unref === 'function') vipExpiryTimer.unref();

  return { staleCleanupTimer, staleLiveCleanupTimer, vipExpiryTimer };
}

module.exports = { startAll };
