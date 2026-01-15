// src/config/redis.js
// Redis configuration for fast presence caching

const Redis = require('ioredis');
const { logger } = require('../utils/logger');

let redisClient = null;

const connectRedis = async () => {
  try {
    // Redis is optional - skip if not configured
    if (!process.env.REDIS_HOST) {
      return null;
    }

    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times) => {
        // Only retry 3 times
        if (times > 3) {
          logger.warn('⚠️ Redis unavailable after 3 retries - continuing without cache');
          return null; // Stop retrying
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false, // Don't queue commands when offline
    });

    redisClient.on('connect', () => {
      logger.info('✅ Redis connected');
    });

    redisClient.on('error', (err) => {
      logger.error('❌ Redis error:', err);
    });

    redisClient.on('ready', () => {
      logger.info('🚀 Redis ready for commands');
    });

    // Test connection
    await redisClient.ping();
    logger.info('🏓 Redis ping successful');

    return redisClient;
  } catch (error) {
    logger.error('❌ Redis connection failed:', error);
    // Don't crash the app if Redis is unavailable
    return null;
  }
};

const getRedisClient = () => {
  return redisClient || null;
};

module.exports = { connectRedis, getRedisClient };
