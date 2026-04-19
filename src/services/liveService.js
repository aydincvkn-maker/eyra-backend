// src/services/liveService.js
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = require("../config/env");
const { getRedisClient } = require("../config/redis");
const LiveStream = require("../models/LiveStream");
const { logger } = require("../utils/logger");

// ============ REDIS CACHE KEYS ============
const CACHE_KEYS = {
  ACTIVE_STREAMS: 'live:active_streams',        // Aktif yayınlar listesi
  STREAM_DETAIL: 'live:stream:',                // Tek yayın detayı (+ roomId)
  VIEWER_COUNT: 'live:viewers:',                // İzleyici sayısı (+ roomId)
};

const CACHE_TTL = {
  ACTIVE_STREAMS: 30,   // 30 saniye
  STREAM_DETAIL: 60,    // 1 dakika
  VIEWER_COUNT: 10,     // 10 saniye
};

// ============ CACHE FUNCTIONS ============

/**
 * Aktif yayınları cache'den al veya DB'den çek
 */
exports.getActiveStreamsWithCache = async (options = {}) => {
  const redis = getRedisClient();
  const { category, limit = 50, page = 1 } = options;
  
  const cacheKey = category 
    ? `${CACHE_KEYS.ACTIVE_STREAMS}:${category}:${page}:${limit}`
    : `${CACHE_KEYS.ACTIVE_STREAMS}:all:${page}:${limit}`;

  // Redis varsa cache'den dene
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info('✅ [Cache HIT] Active streams from Redis');
        return JSON.parse(cached);
      }
    } catch (e) {
      logger.warn('⚠️ Redis get failed:', e.message);
    }
  }

  // DB'den çek
  logger.info('📦 [Cache MISS] Fetching active streams from MongoDB');

  // ✅ PROFESSIONAL: Host offline ise eski yayınlar görünmesin.
  // LiveStream -> User join ile host isOnline/isActive/isBanned filtrelenir.
  const safeLimit = Math.max(1, Math.min(200, parseInt(limit)));
  const safePage = Math.max(1, parseInt(page));
  const skip = (safePage - 1) * safeLimit;

  const match = { isLive: true, status: 'live' };
  if (category) match.category = category;

  const facet = await LiveStream.aggregate([
    { $match: match },
    {
      $lookup: {
        from: 'users',
        localField: 'host',
        foreignField: '_id',
        as: 'host',
      },
    },
    { $unwind: '$host' },
    {
      $match: {
        'host.isOnline': true,
        'host.isActive': { $ne: false },
        'host.isBanned': { $ne: true },
      },
    },
    {
      $project: {
        _id: 1,
        host: {
          _id: '$host._id',
          username: '$host.username',
          name: '$host.name',
          profileImage: '$host.profileImage',
          gender: '$host.gender',
        },
        title: 1,
        description: 1,
        category: 1,
        thumbnailUrl: 1,
        isLive: 1,
        status: 1,
        quality: 1,
        resolution: 1,
        bitrate: 1,
        viewerCount: 1,
        peakViewerCount: 1,
        roomId: 1,
        platform: 1,
        startedAt: 1,
        endedAt: 1,
        duration: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
    { $sort: { viewerCount: -1, createdAt: -1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: safeLimit }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const streams = facet?.[0]?.data || [];
  const total = facet?.[0]?.total?.[0]?.count || 0;

  const result = {
    streams,
    pagination: {
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit),
    },
  };

  // Redis varsa cache'le
  if (redis) {
    try {
      await redis.setex(cacheKey, CACHE_TTL.ACTIVE_STREAMS, JSON.stringify(result));
      logger.info('💾 [Cache SET] Active streams cached for', CACHE_TTL.ACTIVE_STREAMS, 'seconds');
    } catch (e) {
      logger.warn('⚠️ Redis set failed:', e.message);
    }
  }

  return result;
};

/**
 * Tek yayın detayını cache'den al
 */
exports.getStreamDetailWithCache = async (roomId) => {
  const redis = getRedisClient();
  const cacheKey = CACHE_KEYS.STREAM_DETAIL + roomId;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.info('✅ [Cache HIT] Stream detail from Redis:', roomId);
        return JSON.parse(cached);
      }
    } catch (e) {
      logger.warn('⚠️ Redis get failed:', e.message);
    }
  }

  const stream = await LiveStream.findOne({ roomId })
    .populate('host', 'username name profileImage gender bio followers')
    .lean();

  if (stream && redis) {
    try {
      await redis.setex(cacheKey, CACHE_TTL.STREAM_DETAIL, JSON.stringify(stream));
    } catch (e) {
      logger.warn('⚠️ Redis set failed:', e.message);
    }
  }

  return stream;
};

/**
 * Yayın cache'ini invalidate et (yayın başladığında/bittiğinde)
 */
exports.invalidateStreamCache = async (roomId = null) => {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    // Aktif yayınlar listesini temizle
    const keys = await redis.keys(`${CACHE_KEYS.ACTIVE_STREAMS}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info('🧹 [Cache INVALIDATE] Cleared', keys.length, 'active stream cache keys');
    }

    // Belirli yayın detayını temizle
    if (roomId) {
      await redis.del(CACHE_KEYS.STREAM_DETAIL + roomId);
      logger.info('🧹 [Cache INVALIDATE] Cleared stream detail:', roomId);
    }
  } catch (e) {
    logger.warn('⚠️ Cache invalidation failed:', e.message);
  }
};

/**
 * İzleyici sayısını Redis'te artır/azalt (atomic)
 */
exports.updateViewerCountCache = async (roomId, delta) => {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const key = CACHE_KEYS.VIEWER_COUNT + roomId;
    const newCount = await redis.incrby(key, delta);
    await redis.expire(key, CACHE_TTL.VIEWER_COUNT);
    return Math.max(0, newCount);
  } catch (e) {
    logger.warn('⚠️ Viewer count cache update failed:', e.message);
    return null;
  }
};

/**
 * İzleyici sayısını Redis'ten al
 */
exports.getViewerCountFromCache = async (roomId) => {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const count = await redis.get(CACHE_KEYS.VIEWER_COUNT + roomId);
    return count ? parseInt(count) : null;
  } catch (e) {
    return null;
  }
};

// ============ TOKEN GENERATION ============

// ✅ FIX: livekit-server-sdk v2.x'te toJwt() Promise döndürür
exports.generateLiveKitToken = async (roomName, participantName, participantId) => {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participantId || participantName,
    name: participantName,
  });

  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  return await at.toJwt();
};

// ============ LIVEKIT ROOM MANAGEMENT ============

/**
 * LiveKit sunucusundaki odayı sil (stream bittiğinde çağrılır)
 * empty_timeout'a güvenmek yerine proaktif temizlik yapar.
 */
exports.deleteLiveKitRoom = async (roomName) => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    logger.warn('⚠️ LiveKit credentials missing, skipping room deletion');
    return false;
  }
  try {
    // wss:// → https:// for REST API
    const httpUrl = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
    const roomService = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await roomService.deleteRoom(roomName);
    logger.info(`🧹 LiveKit room ${roomName} deleted`);
    return true;
  } catch (err) {
    // Room may already be gone — not an error
    if (err.message?.includes('not found') || err.code === 404) {
      logger.info(`ℹ️ LiveKit room ${roomName} already gone`);
      return true;
    }
    logger.error(`⚠️ LiveKit room deletion failed for ${roomName}:`, err.message);
    return false;
  }
};