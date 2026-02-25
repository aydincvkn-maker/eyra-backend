/**
 * Socket.io JWT authentication middleware.
 * Extracts token from auth.token → headers.authorization → query.token.
 * Optional insecure dev fallback when SOCKET_ALLOW_INSECURE_USERID=true.
 */

const jwt = require('jsonwebtoken');
const { JWT_SECRET, NODE_ENV } = require('../config/env');
const User = require('../models/User');
const { userConnectionTimestamps } = require('./state');
const { logger } = require('../utils/logger');

const CONNECTION_RATE_LIMIT_MS = 1000; // Min 1 second between connections from same user

/**
 * Extract JWT token from the socket handshake in priority order.
 */
const extractSocketToken = (socket) => {
  const authToken = socket.handshake?.auth?.token;
  if (authToken) return String(authToken);

  const headerAuth = socket.handshake?.headers?.authorization;
  if (headerAuth && typeof headerAuth === 'string' && headerAuth.toLowerCase().startsWith('bearer ')) {
    return headerAuth.slice(7).trim();
  }

  const queryToken = socket.handshake?.query?.token;
  if (queryToken) return String(queryToken);

  // Optional dev fallback (disabled by default)
  if (process.env.SOCKET_ALLOW_INSECURE_USERID === 'true') {
    const insecureUserId = socket.handshake?.auth?.userId || socket.handshake?.query?.userId || socket.handshake?.query?.uid;
    if (insecureUserId) return null;
  }

  return null;
};

/**
 * Returns an async middleware function for io.use().
 */
function createAuthMiddleware() {
  return async (socket, next) => {
    try {
      const token = extractSocketToken(socket);
      console.log(`🔐 Socket auth: token=${token ? '✅' : '❌'}`);

      // Optional dev fallback: allow providing userId without JWT ONLY in development
      const ALLOW_INSECURE = NODE_ENV === 'development'
        && process.env.SOCKET_ALLOW_INSECURE_USERID === 'true';

      if (!token && ALLOW_INSECURE) {
        const rawUserId = socket.handshake?.auth?.userId || socket.handshake?.query?.userId || socket.handshake?.query?.uid;
        const userId = String(rawUserId || '').trim();
        console.log(`🔐 Socket auth (insecure mode - DEV ONLY): userId=${userId}`);
        if (!userId) {
          console.log(`❌ Socket auth failed: Missing token and userId`);
          return next(new Error('Missing token'));
        }

        // Rate limit check
        const now = Date.now();
        const lastConnect = userConnectionTimestamps.get(userId);
        if (lastConnect && (now - lastConnect) < CONNECTION_RATE_LIMIT_MS) {
          console.log(`⚠️ Rate limited: ${userId} (${now - lastConnect}ms since last connect)`);
          return next(new Error('Rate limited'));
        }
        userConnectionTimestamps.set(userId, now);

        const user = await User.findById(userId).select('_id gender isBanned isActive').lean();
        if (!user || user.isBanned || user.isActive === false) {
          console.log(`❌ Socket auth failed: User not found or banned`);
          return next(new Error('Unauthorized'));
        }

        socket.data.userId = String(user._id);
        socket.data.gender = user.gender || 'female';
        socket.data.authMode = 'insecure_userId';
        console.log(`✅ Socket auth success (insecure): userId=${user._id}`);
        return next();
      }

      if (!token) {
        console.log(`❌ Socket auth failed: No token provided`);
        return next(new Error('Missing token'));
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = String(decoded?.id || '').trim();
      if (!userId) {
        console.log(`❌ Socket auth failed: Invalid token (no userId)`);
        return next(new Error('Invalid token'));
      }

      // Rate limit check
      const now = Date.now();
      const lastConnect = userConnectionTimestamps.get(userId);
      if (lastConnect && (now - lastConnect) < CONNECTION_RATE_LIMIT_MS) {
        console.log(`⚠️ Rate limited: ${userId} (${now - lastConnect}ms since last connect)`);
        return next(new Error('Rate limited'));
      }
      userConnectionTimestamps.set(userId, now);

      const user = await User.findById(userId).select('_id gender isBanned isActive').lean();
      if (!user || user.isBanned || user.isActive === false) {
        console.log(`❌ Socket auth failed: User not found or banned (userId=${userId})`);
        return next(new Error('Unauthorized'));
      }

      socket.data.userId = String(user._id);
      socket.data.gender = user.gender || 'female';
      socket.data.authMode = 'jwt';
      console.log(`✅ Socket auth success: userId=${user._id}, gender=${user.gender}`);
      return next();
    } catch (e) {
      console.log(`❌ Socket auth exception: ${e.message}`);
      return next(new Error('Unauthorized'));
    }
  };
}

module.exports = { createAuthMiddleware, extractSocketToken };
