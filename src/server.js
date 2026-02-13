const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

const { PORT, JWT_SECRET, NODE_ENV, CLIENT_ORIGIN, MOBILE_ORIGIN } = require("./config/env");
const connectDB = require("./config/db");
const { connectRedis } = require("./config/redis");
const { logger } = require("./utils/logger");
const User = require("./models/User");
const Message = require("./models/Message");
const LiveStream = require("./models/LiveStream");
const presenceService = require("./services/presenceService");
const liveService = require("./services/liveService");
const translationService = require('./services/translationService');

// =========================
// PRESENCE <-> DATABASE SYNC
// =========================

const mongoose = require('mongoose');

// ✅ PROFESSIONAL: Debounce rapid presence changes to reduce DB load
const pendingDbUpdates = new Map(); // userId -> { update, timeoutId }
const DB_SYNC_DEBOUNCE_MS = 2000; // 2 saniye debounce

const persistPresenceToDatabase = async (payload = {}) => {
  const userId = String(payload.userId || "").trim();
  if (!userId) {
    console.warn(`⚠️ persistPresenceToDatabase: userId boş`);
    return;
  }

  const presence = payload.presence || {};
  const now = new Date();

  const isOnline = Boolean(presence.online);
  const isLive = Boolean(presence.live);
  const isBusy = Boolean(presence.busy || presence.inCall);
  const lastSeen = presence.lastSeen ? new Date(presence.lastSeen) : now;

  const update = {
    isOnline,
    isLive,
    isBusy,
    lastSeen,
    presenceStatus: presence.status || (isOnline ? "online" : "offline"),
  };

  if (isOnline) {
    update.lastOnlineAt = now;
  } else {
    update.lastOfflineAt = now;
  }

  // ✅ DEBOUNCE: Cancel previous pending update for same user
  const pending = pendingDbUpdates.get(userId);
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  
  // ✅ IMMEDIATE for offline (0ms), debounced for online (2s)
  // Kullanıcı offline olunca diğerleri HEMEN görmeli
  const delayMs = isOnline ? DB_SYNC_DEBOUNCE_MS : 0;
  
  const timeoutId = setTimeout(async () => {
    try {
      // MongoDB ObjectId'ye çevir - geçerlilik kontrolü
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        console.warn(`⚠️ Invalid userId format for DB sync: ${userId}`);
        return;
      }
      
      const objectId = new mongoose.Types.ObjectId(userId);
      
      const result = await User.updateOne({ _id: objectId }, { $set: update });
      
      // Sadece gerçekten değişiklik olduğunda logla (spam önleme)
      if (result.modifiedCount > 0) {
        console.log(`🔄 Presence DB sync: ${userId} -> ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
      }
    } catch (err) {
      logger.warn(`⚠️ Presence DB sync failed for ${userId}: ${err.message}`);
    } finally {
      // ✅ ALWAYS cleanup, even if update fails
      pendingDbUpdates.delete(userId);
    }
  }, delayMs);
  
  pendingDbUpdates.set(userId, { update, timeoutId });
};

// ✅ SINGLE EVENT LISTENER - Handles both DB sync and socket broadcast
// Previous bug: There were 2 separate listeners causing duplicate processing
// ✅ MEMORY LEAK FIX: Store handler reference for cleanup
const onPresenceChanged = (payload) => {
  const userId = payload.userId;
  const presence = payload.presence || {};
  const status = presence.status || 'unknown';
  
  console.log(`📡 Presence changed: ${userId} -> ${status}`);
  
  // 1. Persist to database (async, non-blocking)
  persistPresenceToDatabase(payload).catch((err) => {
    logger.warn(`⚠️ Presence DB sync error: ${err.message}`);
  });
  
  // 2. Broadcast to connected sockets (gender-filtered)
  try {
    emitPresenceUpdateToVisibleSockets(presence);
  } catch (e) {
    logger.error('❌ Presence broadcast error:', e);
  }

  // 3. ✅ LIVE STREAM CLEANUP: Host offline olunca aktif yayını otomatik kapat
  // Kullanıcı yayını manuel kapatmadan uygulama kapanır/crash olursa eski yayın listede kalmasın.
  if (String(status) === 'offline') {
    const reason = payload?.meta?.reason || 'presence_offline';
    closeActiveLiveStreamsForHost(userId, reason).catch((e) => {
      logger.warn(`⚠️ Live auto-end failed for ${userId}: ${e.message}`);
    });
  }
};

presenceService.on("changed", onPresenceChanged);

// =========================
// ✅ LIVE STREAM AUTO-END (OFFLINE)
// =========================

async function closeActiveLiveStreamsForHost(userId, reason = 'presence_offline') {
  const uid = String(userId || '').trim();
  if (!uid) return;

  const stream = await LiveStream.findOne({ host: uid, isLive: true, status: 'live' });
  if (!stream) return;

  const streamRoomId = stream.roomId;
  const finalViewerCount = stream.viewerCount || 0;

  stream.isLive = false;
  stream.status = 'ended';
  stream.endedAt = new Date();
  stream.viewerCount = 0;
  stream.viewers = [];
  await stream.save();

  // User flags
  try {
    await User.updateOne({ _id: uid }, { $set: { isLive: false } }, { runValidators: false });
  } catch (e) {
    logger.warn(`⚠️ User isLive reset failed (${uid}): ${e.message}`);
  }

  // Cache invalidate
  try {
    await liveService.invalidateStreamCache(streamRoomId);
  } catch (e) {
    logger.warn(`⚠️ Cache invalidation failed (${streamRoomId}): ${e.message}`);
  }

  // Socket notify
  if (global.io) {
    global.io.to(streamRoomId).emit('stream_ended', {
      roomId: streamRoomId,
      hostId: uid,
      duration: stream.duration,
      totalGiftsValue: stream.totalGiftsValue,
      peakViewerCount: stream.peakViewerCount,
      finalViewerCount,
      endedAt: stream.endedAt,
      reason,
    });

    // Room'daki socket'ları çıkar
    try {
      const sockets = await global.io.in(streamRoomId).fetchSockets();
      for (const s of sockets) {
        s.leave(streamRoomId);
      }
    } catch (e) {
      logger.warn(`⚠️ Socket room cleanup failed (${streamRoomId}): ${e.message}`);
    }
  }

  console.log(`📺 Auto-ended stream ${streamRoomId} for host ${uid} (reason=${reason})`);
}

// ROUTES
const authRoutes = require("./routes/authRoutes");
const authMiddleware = require("./middleware/auth");
const adminMiddleware = require("./middleware/admin");
const userRoutes = require("./routes/userRoutes");
const liveRoutes = require("./routes/liveRoutes");
const giftRoutes = require("./routes/giftRoutes");
const chatRoutes = require("./routes/chatRoutes");
const reportRoutes = require("./routes/reportRoutes");
const statsRoutes = require("./routes/statsRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const callRoutes = require("./routes/callRoutes");
const debugRoutes = require("./routes/debugRoutes");
const supportRoutes = require("./routes/supportRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const missionRoutes = require("./routes/missionRoutes");
const spinRoutes = require("./routes/spinRoutes");
const achievementRoutes = require("./routes/achievementRoutes");
const verificationRoutes = require("./routes/verificationRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const { generalLimiter } = require("./middleware/rateLimit");

const app = express();
const server = http.createServer(app);
const parseOrigins = (value) => {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const allowedOrigins = new Set([
  ...parseOrigins(CLIENT_ORIGIN),
  ...parseOrigins(MOBILE_ORIGIN),
]);

const isOriginAllowed = (origin) => {
  if (!origin) return true; // non-browser clients
  if (allowedOrigins.has("*")) return true;
  return allowedOrigins.has(origin);
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: false,
  },
  transports: ['polling', 'websocket'], // Polling first for better mobile support
  path: '/socket.io/',
  serveClient: false,
  pingInterval: 25000,
  pingTimeout: 120000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
});

// ✅ SCALABILITY: Redis Adapter for multi-instance support
if (process.env.REDIS_HOST) {
  try {
    const pubClient = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    });
    const subClient = pubClient.duplicate();

    io.adapter(createAdapter(pubClient, subClient));
    console.log("✅ Redis Adapter connected (Scalable Presence Mode)");
  } catch (err) {
    console.warn("⚠️ Redis Adapter init failed:", err.message);
  }
}

// Enable debug mode
if (process.env.NODE_ENV === 'development') {
  require('debug')('socket.io:*')();
}

// Socket.io bağlantıları
// userId -> Set<socketId>
const userSockets = new Map();
// roomName -> { callerId, targetUserId, createdAt }
const activeCalls = new Map();
// userId -> Array<{ callerId, callerName, roomName, createdAt }>
const pendingCalls = new Map();

// Allow controllers/services (e.g. logout) to access socket state safely.
// This keeps the existing architecture but fixes undefined global references.
global.io = io;
global.userSockets = userSockets;
global.activeCalls = activeCalls;
global.pendingCalls = pendingCalls;

// =========================
// ✅ STALE DATA CLEANUP JOBS
// =========================

// Cleanup stale activeCalls (calls older than 2 hours)
const STALE_CALL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 saat
const STALE_PENDING_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 dakika

const cleanupStaleCalls = () => {
  const now = Date.now();
  let cleanedCalls = 0;
  let cleanedPending = 0;

  // Cleanup activeCalls
  for (const [roomName, callInfo] of activeCalls.entries()) {
    const createdAt = callInfo.createdAt instanceof Date 
      ? callInfo.createdAt.getTime() 
      : (typeof callInfo.createdAt === 'number' ? callInfo.createdAt : 0);
    
    if (now - createdAt > STALE_CALL_TIMEOUT_MS) {
      activeCalls.delete(roomName);
      cleanedCalls++;
      console.log(`🧹 Stale call cleaned: ${roomName} (created ${Math.round((now - createdAt) / 60000)} minutes ago)`);
    }
  }

  // Cleanup pendingCalls
  for (const [userId, calls] of pendingCalls.entries()) {
    if (!Array.isArray(calls)) {
      pendingCalls.delete(userId);
      continue;
    }

    const freshCalls = calls.filter(call => {
      const createdAt = call.createdAt instanceof Date 
        ? call.createdAt.getTime() 
        : (typeof call.createdAt === 'number' ? call.createdAt : 0);
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
  
  // ✅ CACHE CLEANUP: Remove socketGenderCache entries for disconnected sockets
  let cleanedCacheEntries = 0;
  for (const [socketId, _] of socketGenderCache.entries()) {
    if (!io.sockets.sockets.has(socketId)) {
      socketGenderCache.delete(socketId);
      cleanedCacheEntries++;
    }
  }
  
  // ✅ RATE LIMIT CLEANUP: Remove old timestamps (older than 5 minutes)
  let cleanedRateLimitEntries = 0;
  const rateLimitMaxAge = 5 * 60 * 1000; // 5 dakika
  if (typeof userConnectionTimestamps !== 'undefined') {
    for (const [userId, timestamp] of userConnectionTimestamps.entries()) {
      if (now - timestamp > rateLimitMaxAge) {
        userConnectionTimestamps.delete(userId);
        cleanedRateLimitEntries++;
      }
    }
  }

  if (cleanedCalls > 0 || cleanedPending > 0 || cleanedCacheEntries > 0 || cleanedRateLimitEntries > 0) {
    console.log(`🧹 Stale cleanup: ${cleanedCalls} calls, ${cleanedPending} pending, ${cleanedCacheEntries} cache, ${cleanedRateLimitEntries} rate-limit entries removed`);
  }
};

// Run cleanup every 5 minutes
const staleCleanupTimer = setInterval(cleanupStaleCalls, 5 * 60 * 1000);

// =========================
// ✅ STALE LIVE STREAM CLEANUP JOB
// =========================
// Server restart/edge-case: DB'de isLive=true kalan yayınları temizler.
// Host offline ise (ve en az 30sn geçmişse) yayını kapat.

const STALE_LIVE_OFFLINE_GRACE_MS = 30 * 1000;

const cleanupStaleLiveStreams = async () => {
  try {
    const cutoff = new Date(Date.now() - STALE_LIVE_OFFLINE_GRACE_MS);

    // Host offline ve offlineAt eskiyse kapat
    const stale = await LiveStream.find({ isLive: true, status: 'live' })
      .populate('host', 'isOnline lastOfflineAt isActive isBanned')
      .select('_id roomId host viewerCount duration totalGiftsValue peakViewerCount')
      .limit(500);

    let closed = 0;
    for (const s of stale) {
      const host = s.host;
      const hostOfflineLongEnough = host?.lastOfflineAt && host.lastOfflineAt <= cutoff;
      const shouldClose = !host || host.isOnline !== true || host.isActive === false || host.isBanned === true;

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
};

// Run every 2 minutes
const staleLiveCleanupTimer = setInterval(cleanupStaleLiveStreams, 2 * 60 * 1000);

if (typeof staleCleanupTimer.unref === 'function') {
  staleCleanupTimer.unref(); // Don't keep process alive just for this
}

// =========================
// SOCKET AUTH (JWT)
// =========================

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

// ✅ DEBUG: Log all incoming connection attempts before auth
// ✅ FIX: Rate limiting for socket connections per user
// Prevents reconnect loops from overwhelming the server
const userConnectionTimestamps = new Map(); // userId -> lastConnectTime
const CONNECTION_RATE_LIMIT_MS = 1000; // Minimum 1 second between connections from same user

io.engine.on("connection_error", (err) => {
  console.log("❌ Socket connection error:", err.req?.url, err.code, err.message, err.context);
});

io.engine.on("initial_headers", (headers, req) => {
  if (process.env.DEBUG_SOCKET_HANDSHAKE === 'true') {
    console.log("📡 New socket handshake request:", req.url);
  }
});

io.use(async (socket, next) => {
  try {
    const token = extractSocketToken(socket);
    console.log(`🔐 Socket auth: token=${token ? '✅' : '❌'}`);

    // Optional dev fallback: allow providing userId without JWT ONLY in development
    // ✅ SECURITY: Restrict to development environment only
    const ALLOW_INSECURE = process.env.NODE_ENV === 'development' 
      && process.env.SOCKET_ALLOW_INSECURE_USERID === 'true';
    
    if (!token && ALLOW_INSECURE) {
      const rawUserId = socket.handshake?.auth?.userId || socket.handshake?.query?.userId || socket.handshake?.query?.uid;
      const userId = String(rawUserId || '').trim();
      console.log(`🔐 Socket auth (insecure mode - DEV ONLY): userId=${userId}`);
      if (!userId) {
        console.log(`❌ Socket auth failed: Missing token and userId`);
        return next(new Error('Missing token'));
      }

      // ✅ Rate limit check for insecure mode
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

    // ✅ Rate limit check for JWT mode
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
});

// =========================
// PRESENCE BROADCAST (filtered by gender)
// =========================

const canSeeTarget = (viewerGender, targetGender) => {
  const viewer = String(viewerGender || '').toLowerCase();
  const target = String(targetGender || '').toLowerCase();
  if (viewer === 'male') return target === 'female';
  return true; // female/other -> sees all
};

// ✅ PROFESSIONAL: Cache socket genders for faster broadcast
const socketGenderCache = new Map(); // socketId -> gender

const emitPresenceUpdateToVisibleSockets = (targetPresence) => {
  const userId = String(targetPresence?.userId || '').trim();
  if (!userId) return;

  const targetGender = targetPresence?.gender || null;
  const status = targetPresence?.status || (targetPresence?.online ? 'online' : 'offline');
  const lastSeen = targetPresence?.lastSeen || Date.now();

  const payload = {
    userId,
    status,
    lastSeen,
    timestamp: Date.now(),
  };

  // Backward-compatible payloads (existing Flutter listeners)
  const legacy = {
    userId,
    presenceStatus: status,
    isOnline: status !== 'offline',
    isLive: status === 'live',
    isBusy: status === 'in_call',
    inCall: status === 'in_call',
    timestamp: new Date().toISOString(),
  };
  
  // ✅ OPTIMIZED: Use Socket.io rooms for gender-based broadcasting
  try {
    // Determine which rooms should receive this update
    if (targetGender === 'female') {
      // Female users visible to everyone (sending ONLY new standard payload)
      io.to('viewer-male').to('viewer-female').to('viewer-other').emit('presence-update', payload);
    } else {
      // Male/other users only visible to female/other viewers
      io.to('viewer-female').to('viewer-other').emit('presence-update', payload);
    }
    
    // ✅ DEBUG: Log broadcast stats periodically (only in dev)
    if (process.env.NODE_ENV === 'development' && Math.random() < 0.01) {
      console.log(`📡 Presence broadcast: ${userId} -> ${status} (rooms: ${targetGender === 'female' ? 'all' : 'female+other'})`);
    }
  } catch (e) {
    logger.error('❌ Presence broadcast error:', e);
  }
};

// Send a one-time batch snapshot to a single socket (used on connect/register)
const emitAllVisiblePresenceToSocket = async (socket) => {
  try {
    const viewerGender = socket?.data?.gender;
    const onlineUsers = await presenceService.getOnlineUsers();

    const users = {};
    for (const u of onlineUsers) {
      const userId = String(u.userId || '').trim();
      if (!userId) continue;

      const targetGender = u.gender || null;
      if (!canSeeTarget(viewerGender, targetGender)) continue;

      const status = u.status || (u.online ? 'online' : 'offline');
      users[userId] = {
        userId,
        presenceStatus: status,
        isOnline: status !== 'offline',
        isLive: status === 'live',
        isBusy: status === 'in_call',
        inCall: status === 'in_call',
        lastSeen: u.lastSeen || null,
        timestamp: new Date().toISOString(),
      };
    }

    socket.emit('presence:all-users-updated', {
      users,
      timestamp: Date.now(),
    });
  } catch (e) {
    logger.warn(`⚠️ emitAllVisiblePresenceToSocket failed: ${e.message}`);
  }
};

// ✅ NOTE: Presence broadcast is now handled in the single 'changed' listener above
// This prevents duplicate broadcasts and improves performance

io.on("connection", (socket) => {
  // ✅ Socket bağlantı logu
  const userId = socket.data?.userId || 'unknown';
  const gender = socket.data?.gender || 'other';
  console.log(`✅ Socket connected: userId=${userId}, socketId=${socket.id}, gender=${gender}`);
  
  // ✅ PERFORMANCE: Join gender-based room for efficient broadcasting
  const roomName = `viewer-${gender}`;
  socket.join(roomName);
  console.log(`📡 Socket ${socket.id} joined room: ${roomName}`);

  // Server-side heartbeat fallback:
  // Some clients (especially web) may not emit explicit heartbeat events.
  // We still want presence to reflect actual socket connectivity, so we
  // periodically refresh lastPing while the socket is alive.
  let serverHeartbeatTimer = null;

  const stopServerHeartbeat = () => {
    if (serverHeartbeatTimer) {
      clearInterval(serverHeartbeatTimer);
      serverHeartbeatTimer = null;
    }
  };

  const startServerHeartbeat = () => {
    stopServerHeartbeat(); // Önce eski timer'ı temizle

    // Server-side heartbeat fallback is OPTIONAL.
    // If enabled, presence will track socket connectivity even when the client
    // stops sending heartbeats (e.g., app background). If disabled, presence
    // will rely on explicit client heartbeats and sweep timeout.
    const enableServerHeartbeat = String(process.env.PRESENCE_ENABLE_SERVER_HEARTBEAT || 'false').toLowerCase() === 'true';
    if (!enableServerHeartbeat) {
      return;
    }
    
    const userId = String(socket.data.userId || '').trim();
    if (!userId) return;

    const intervalMs = Number(process.env.PRESENCE_SERVER_HEARTBEAT_INTERVAL_MS || 10_000);
    const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 1_000 ? intervalMs : 10_000;

    serverHeartbeatTimer = setInterval(() => {
      try {
        presenceService.heartbeat(userId, { socketId: socket.id });
      } catch (_) {
        // ignore
      }
    }, safeIntervalMs);

    if (typeof serverHeartbeatTimer.unref === 'function') {
      serverHeartbeatTimer.unref();
    }
  };

  // ✅ Guard against duplicate registration
  let isRegistered = false;
  let registrationInProgress = false;
  
  const registerUser = async () => {
    const userId = String(socket.data.userId || '').trim();
    if (!userId) return;
    
    // ✅ DUPLICATE REGISTRATION FIX: Prevent multiple registrations
    if (isRegistered || registrationInProgress) {
      logger.info(`🔄 User ${userId} already registered or registration in progress, skipping`);
      return;
    }
    
    // ✅ Set flags IMMEDIATELY before async operations
    registrationInProgress = true;
    
    try {
      // Registration logic will complete below
    } catch (err) {
      registrationInProgress = false;
      throw err;
    }

    // IMPORTANT:
    // Disconnecting different users just because they share the same IP breaks
    // NAT/households/emulators (many devices can legitimately share one IP).
    // Keep this behavior ONLY as an explicit opt-in for specific deployments.
    const kickDifferentUserSameIP = String(process.env.SOCKET_KICK_DIFFERENT_USER_SAME_IP || 'false').toLowerCase() === 'true';
    if (kickDifferentUserSameIP) {
      const clientIP = socket.handshake?.address || socket.request?.connection?.remoteAddress || '';
      for (const [existingUserId, socketSet] of userSockets.entries()) {
        if (existingUserId === userId) continue; // Aynı kullanıcı, atla

        for (const sid of socketSet) {
          const existingSocket = io.sockets.sockets.get(sid);
          if (!existingSocket) continue;

          const existingIP = existingSocket.handshake?.address || existingSocket.request?.connection?.remoteAddress || '';
          if (existingIP === clientIP && clientIP !== '') {
            console.log(`🔄 Same IP different user: ${existingUserId} -> ${userId}. Disconnecting old socket (opt-in).`);

            try {
              await presenceService.setOffline(existingUserId, { socketId: sid, reason: 'new_user_same_ip' });
            } catch (e) {
              console.warn(`⚠️ Old user offline failed: ${e.message}`);
            }

            existingSocket.disconnect(true);
            socketSet.delete(sid);
          }
        }

        if (socketSet.size === 0) {
          userSockets.delete(existingUserId);
        }
      }
    }

    // Enforce single socket per user: disconnect older sockets
    // ✅ FIX: Don't disconnect immediately - just remove from map and let them timeout
    // This prevents the race condition where disconnect event fires AFTER new socket registers
    const existing = userSockets.get(userId) || new Set();
    const oldSocketIds = [];
    for (const sid of existing) {
      if (sid !== socket.id) {
        oldSocketIds.push(sid);
      }
    }

    // ✅ First, update the map with ONLY the new socket
    const onlyThis = new Set([socket.id]);
    userSockets.set(userId, onlyThis);
    
    console.log(`\n✅ SOCKET REGISTERED`);
    console.log(`   userId: "${userId}" (type: ${typeof userId}, length: ${userId.length})`);
    console.log(`   socketId: ${socket.id}`);
    console.log(`   Old sockets to cleanup: ${oldSocketIds.length}`);
    console.log(`   Total users in map: ${userSockets.size}`);
    console.log(`   Map keys: ${Array.from(userSockets.keys()).map(k => `"${k}"`).join(', ')}\n`);

    try {
      // ✅ presenceService.setOnline will emit 'changed' event
      // which triggers persistPresenceToDatabase - NO DUPLICATE DB UPDATE NEEDED
      await presenceService.setOnline(userId, {
        socketId: socket.id,
        gender: socket.data.gender,
      });
      
      // ✅ Mark as registered AFTER successful online status
      isRegistered = true;
      registrationInProgress = false;
      
      // ✅ FIX: Don't forcefully disconnect old sockets
      // Just remove them from the map - they will timeout naturally
      // or disconnect on their own. This prevents the reconnect loop.
      // The old sockets are already removed from userSockets map above,
      // so they won't receive any events and will eventually disconnect.
      if (oldSocketIds.length > 0) {
        console.log(`ℹ️ Old sockets removed from map (will timeout): ${oldSocketIds.join(', ')}`);
        // Old approach caused reconnect loops:
        // oldSocket.disconnect(true) -> client receives "io server disconnect" -> client reconnects
        // New approach: let old sockets timeout naturally via pingTimeout
      }
    } catch (err) {
      console.error('❌ presence setOnline error:', err.message);
      registrationInProgress = false;
      throw err;
    }

    // ✅ Initial batch snapshot so clients can render presence immediately
    await emitAllVisiblePresenceToSocket(socket);

    // Keep presence alive while this socket is connected
    startServerHeartbeat();

    // Deliver pending calls queued while this user was offline
    try {
      const queued = pendingCalls.get(userId);
      if (queued && Array.isArray(queued) && queued.length > 0) {
        queued.forEach((c) => {
          emitToUserSockets(userId, 'incoming_call', {
            callerId: c.callerId,
            callerName: c.callerName,
            roomName: c.roomName,
          });
        });
        pendingCalls.delete(userId);
      }
    } catch (e) {
      console.error('❌ Pending call delivery error:', e);
    }
  };

  // Register immediately on connect (JWT-authenticated)
  registerUser();

  // Backward compatible: ignore userId argument, just ensure registration
  socket.on('register', async () => {
    await registerUser();
  });

  // Heartbeat events (required)
  const onHeartbeat = async () => {
    try {
      const userId = socket.data.userId;
      if (!userId) return;
      await presenceService.heartbeat(userId, { socketId: socket.id, gender: socket.data.gender });
    } catch (e) {
      logger.error(`❌ Heartbeat error for socket ${socket.id}:`, e);
    }
  };

  // New protocol
  socket.on('user:heartbeat', onHeartbeat);
  // Backward compatible
  socket.on('presence:ping', onHeartbeat);

  // Status changes (live / in_call / online)
  socket.on('user:set_status', async (status) => {
    try {
      const userId = socket.data.userId;
      if (!userId) return;
      await presenceService.setStatus(userId, status, {
        socketId: socket.id,
        gender: socket.data.gender,
      });
    } catch (e) {
      logger.error(`❌ Set status error for socket ${socket.id}:`, e);
      // ignore invalid statuses
    }
  });

  // ============ LIVE STREAM SOCKET EVENTS ============
  
  // İzleyici yayın odasına katılıyor (Socket.io room)
  socket.on('live:join_room', async ({ roomId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) {
      console.log(`⚠️ live:join_room - missing roomId or userId`);
      return;
    }
    
    try {
      // Socket.io room'a katıl
      socket.join(roomId);
      console.log(`📺 User ${userId} joined live room: ${roomId}`);
      
      // ✅ DATABASE SYNC: ViewerCount'ı atomic olarak güncelle
      const updatedStream = await LiveStream.findOneAndUpdate(
        { roomId, isLive: true, status: "live" },
        {
          $inc: { viewerCount: 1 },
          $addToSet: { viewers: userId }
        },
        { new: true }
      ).select('viewerCount peakViewerCount');
      
      if (updatedStream) {
        // Peak viewer count'ı güncelle
        if (updatedStream.viewerCount > updatedStream.peakViewerCount) {
          await LiveStream.updateOne(
            { _id: updatedStream._id },
            { $max: { peakViewerCount: updatedStream.viewerCount } }
          );
        }
        
        // Odadaki diğer kullanıcılara bildir
        socket.to(roomId).emit('viewer_joined', {
          roomId,
          userId,
          viewerCount: updatedStream.viewerCount,
          timestamp: Date.now()
        });
      }
    } catch (e) {
      console.error('❌ live:join_room error:', e.message);
      socket.emit('error', { message: 'join_room_failed' });
    }
  });
  
  // İzleyici yayın odasından ayrılıyor
  socket.on('live:leave_room', async ({ roomId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) {
      console.log(`⚠️ live:leave_room - missing roomId or userId`);
      return;
    }
    
    try {
      // Socket.io room'dan ayrıl
      socket.leave(roomId);
      console.log(`📺 User ${userId} left live room: ${roomId}`);
      
      // ✅ DATABASE SYNC: ViewerCount'ı atomic olarak azalt
      const updatedStream = await LiveStream.findOneAndUpdate(
        { roomId },
        {
          $inc: { viewerCount: -1 },
          $pull: { viewers: userId }
        },
        { new: true }
      ).select('viewerCount');
      
      if (updatedStream) {
        // ViewerCount negatif olmasın
        let finalCount = updatedStream.viewerCount;
        if (finalCount < 0) {
          await LiveStream.updateOne(
            { _id: updatedStream._id },
            { $set: { viewerCount: 0 } }
          );
          finalCount = 0;
        }
        
        // Odadaki diğer kullanıcılara bildir
        socket.to(roomId).emit('viewer_left', {
          roomId,
          userId,
          viewerCount: finalCount,
          timestamp: Date.now()
        });
      }
    } catch (e) {
      console.error('❌ live:leave_room error:', e.message);
      socket.emit('error', { message: 'leave_room_failed' });
    }
  });
  
  // Yayın içi chat mesajı (real-time)
  socket.on('live:chat_message', async ({ roomId, message, type = 'text' }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId || !message) {
      console.log(`⚠️ live:chat_message - missing required fields`);
      return;
    }
    
    try {
      // ✅ VALIDATION: Yayın aktif mi kontrol et
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) {
        socket.emit('error', { message: 'stream_not_found' });
        return;
      }
      
      // Message length check
      if (message.length > 500) {
        socket.emit('error', { message: 'message_too_long' });
        return;
      }
      
      // Kullanıcı bilgilerini al
      const user = await User.findById(userId).select('username name profileImage').lean();
      if (!user) {
        socket.emit('error', { message: 'user_not_found' });
        return;
      }
      
      // Mesajı MongoDB'ye kaydet
      const msg = await require('./models/Message').create({
        roomId,
        from: userId,
        type,
        content: message,
      });
      
      // Tüm odaya yayınla (gönderen dahil)
      io.to(roomId).emit('chat_message', {
        _id: msg._id,
        roomId,
        type,
        content: message,
        sender: {
          _id: userId,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage
        },
        timestamp: msg.createdAt
      });
    } catch (e) {
      console.error('❌ live:chat_message error:', e.message);
      socket.emit('error', { message: 'chat_send_failed' });
    }
  });

  // ✅ PINNED MESSAGE - Yayıncı mesaj sabitleyebilir
  socket.on('live:pin_message', async ({ roomId, messageId, content }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) return;
    
    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) return;
      
      // Sadece yayıncı mesaj sabitleyebilir
      if (stream.hostId.toString() !== userId) {
        socket.emit('error', { message: 'only_host_can_pin' });
        return;
      }
      
      // Tüm odaya pinned message yayınla
      io.to(roomId).emit('message_pinned', {
        roomId,
        messageId,
        content,
        pinnedAt: new Date()
      });
      
      console.log(`📌 Message pinned in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:pin_message error:', e.message);
    }
  });

  // ✅ UNPIN MESSAGE
  socket.on('live:unpin_message', async ({ roomId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) return;
    
    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream || stream.hostId.toString() !== userId) return;
      
      io.to(roomId).emit('message_unpinned', { roomId });
      console.log(`📌 Message unpinned in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:unpin_message error:', e.message);
    }
  });

  // ✅ MUTE USER - Yayıncı kullanıcı susturabilir
  socket.on('live:mute_user', async ({ roomId, targetUserId, duration = 300 }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId || !targetUserId) return;
    
    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) return;
      
      // Sadece yayıncı susturabilir
      if (stream.hostId.toString() !== userId) {
        socket.emit('error', { message: 'only_host_can_mute' });
        return;
      }
      
      // Kullanıcıya ve tüm odaya bildir
      io.to(roomId).emit('user_muted', {
        roomId,
        mutedUserId: targetUserId,
        mutedUntil: new Date(Date.now() + duration * 1000),
        duration
      });
      
      console.log(`🔇 User ${targetUserId} muted for ${duration}s in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:mute_user error:', e.message);
    }
  });

  // ✅ UNMUTE USER
  socket.on('live:unmute_user', async ({ roomId, targetUserId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId || !targetUserId) return;
    
    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream || stream.hostId.toString() !== userId) return;
      
      io.to(roomId).emit('user_unmuted', {
        roomId,
        unmutedUserId: targetUserId
      });
      
      console.log(`🔊 User ${targetUserId} unmuted in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:unmute_user error:', e.message);
    }
  });

  // ✅ CALL SIGNALING EVENTS
  const forwardCallEvent = async (eventName, roomName) => {
    const senderId = socket.data.userId;
    if (!senderId) {
      console.log(`⚠️ ${eventName} received but senderId missing`);
      return;
    }
    if (!roomName) {
      console.log(`⚠️ ${eventName} received but roomName missing`);
      return;
    }

    const counterpartyId = getCounterpartyForRoom(roomName, senderId);
    if (!counterpartyId) {
      console.log(`⚠️ ${eventName} - no counterparty found for room ${roomName}`);
      return;
    }

    console.log(`📞 Forwarding ${eventName} from ${senderId} to ${counterpartyId} for room ${roomName}`);
    emitToUserSockets(counterpartyId, eventName, {
      roomName,
      fromUserId: String(senderId),
    });

    // ✅ CLEANUP: Get call info BEFORE deleting from activeCalls
    if (eventName === "call:ended" || eventName === "call:rejected") {
      const callInfo = activeCalls.get(roomName);
      if (callInfo) {
        // Set both users as no longer busy
        try {
          await presenceService.setBusy(callInfo.callerId, false).catch(e => 
            console.error(`⚠️ setBusy cleanup for ${callInfo.callerId} failed: ${e}`)
          );
          await presenceService.setBusy(callInfo.targetUserId, false).catch(e => 
            console.error(`⚠️ setBusy cleanup for ${callInfo.targetUserId} failed: ${e}`)
          );
          console.log(`✅ Both users set as not busy for room: ${roomName}`);
        } catch (e) {
          console.error(`⚠️ setBusy cleanup error: ${e}`);
        }
      }
      
      // Delete from active calls after setting offline
      activeCalls.delete(roomName);
      console.log(`🧹 Cleaned up call: ${roomName}`);
    }
  };

  socket.on("call:accept", ({ roomName }) => forwardCallEvent("call:accepted", roomName));
  socket.on("call:reject", ({ roomName }) => forwardCallEvent("call:rejected", roomName));
  socket.on("call:end", ({ roomName }) => forwardCallEvent("call:ended", roomName));
  socket.on("call:cancel", ({ roomName }) => forwardCallEvent("call:cancelled", roomName));

  // ============ PRIVATE CHAT SOCKET EVENTS ============
  const chatService = require('./services/chatService');
  
  // ✅ Send private chat message
  socket.on('chat:send_message', async (data) => {
    const fromUserId = socket.data.userId;
    console.log(`📩 chat:send_message received - fromUserId: ${fromUserId}, to: ${data.to}, text: ${data.text?.substring(0, 20)}`);
    
    if (!fromUserId || !data.to) {
      console.log('⚠️ chat:send_message - missing userId or recipient');
      socket.emit('chat:error', {
        tempId: data.tempId,
        error: 'Missing userId or recipient'
      });
      return;
    }
    
    try {
      console.log(`📩 Calling chatService.sendMessage...`);
      const message = await chatService.sendMessage(fromUserId, data.to, {
        text: data.text,
        replyToId: data.replyToId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType
      });
      
      console.log(`📩 Message saved with id: ${message._id}`);
      
      const messageData = {
        messageId: message._id.toString(),
        from: fromUserId,
        to: data.to,
        text: message.content,
        timestamp: message.createdAt,
        replyToId: data.replyToId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        isMe: false
      };
      
      // Send to recipient
      emitToUserSockets(data.to, 'chat:new_message', messageData);
      
      // Confirm to sender
      socket.emit('chat:new_message', {
        ...messageData,
        isMe: true,
        tempId: data.tempId
      });
      
      console.log(`💬 Chat message sent: ${fromUserId} -> ${data.to}`);
    } catch (error) {
      console.error('❌ chat:send_message error:', error.message);
      
      let errorMessage = 'Failed to send message';
      if (error.message === 'RATE_LIMIT_EXCEEDED') errorMessage = 'Too many messages. Please slow down.';
      if (error.message === 'USER_BLOCKED') errorMessage = 'user_blocked';
      
      socket.emit('chat:error', {
        tempId: data.tempId,
        error: errorMessage
      });
    }
  });

  // ✅ Typing indicator
  socket.on('chat:typing', (data) => {
    const fromUserId = socket.data.userId;
    if (!fromUserId || !data.to) return;
    
    emitToUserSockets(data.to, 'chat:typing', {
      from: fromUserId,
      fromUserId: fromUserId,
      isTyping: data.isTyping || false
    });
  });

  // ✅ Mark messages as read
  socket.on('chat:mark_read', (data) => {
    const userId = socket.data.userId;
    if (!userId || !data.from) return;
    
    emitToUserSockets(data.from, 'chat:messages_read', {
      by: userId,
      conversationWith: data.from
    });
  });

  // ============ CALL IN-CHAT MESSAGING WITH TRANSLATION ============
  // Görüntülü arama sırasında mesaj gönderme (UI tarafında çeviri ibaresi yok; sadece displayContent kullanılır)
  socket.on('call:message', async ({ roomName, content, targetLanguage, tempId }) => {
    const senderId = socket.data.userId;
    if (!senderId || !roomName || !content) {
      console.log(`⚠️ call:message - missing required fields`);
      return;
    }

    console.log(`💬 call:message received sender=${senderId} room=${roomName} tempId=${tempId || '-'}`);

    try {
      if (String(content).length > 500) {
        socket.emit('call:message_error', { error: 'message_too_long', maxLength: 500, tempId });
        return;
      }

      const sender = await User.findById(senderId)
        .select('username name profileImage preferredLanguage')
        .lean();

      if (!sender) {
        socket.emit('call:message_error', { error: 'user_not_found', tempId });
        return;
      }

      const receiverId = getCounterpartyForRoom(roomName, senderId);
      if (!receiverId) {
        console.log(`⚠️ call:message - counterparty not found for room=${roomName} sender=${senderId}`);
        socket.emit('call:message_error', { error: 'call_not_found', tempId });
        return;
      }

      const receiver = await User.findById(receiverId).select('preferredLanguage').lean();

      const senderLang = sender.preferredLanguage || 'tr';
      const receiverLang = receiver?.preferredLanguage || targetLanguage || 'tr';

      let originalLanguage = senderLang;
      let translatedContent = String(content);
      const translations = {};

      if (senderLang !== receiverLang) {
        try {
          const translateResult = await translationService.translateText(
            String(content),
            receiverLang,
            'auto'
          );

          originalLanguage = translateResult.detectedLanguage || senderLang;
          translatedContent = translateResult.translatedText || String(content);

          translations[originalLanguage] = String(content);
          translations[receiverLang] = translatedContent;
        } catch (translateErr) {
          console.error('❌ Translation error:', translateErr.message);
          translatedContent = String(content);
        }
      }

      const message = await Message.create({
        roomId: roomName,
        from: senderId,
        to: receiverId,
        type: 'call_chat',
        content: String(content),
        originalContent: String(content),
        originalLanguage,
        translations,
      });

      const messagePayload = {
        _id: message._id.toString(),
        roomName,
        content: String(content),
        translatedContent,
        originalLanguage,
        targetLanguage: receiverLang,
        isTranslated: String(content) !== translatedContent,
        tempId,
        sender: {
          _id: String(senderId),
          username: sender.username,
          name: sender.name,
          profileImage: sender.profileImage,
        },
        timestamp: message.createdAt,
      };

      socket.emit('call:message_sent', {
        ...messagePayload,
        displayContent: String(content),
      });

      emitToUserSockets(receiverId, 'call:message_received', {
        ...messagePayload,
        displayContent: translatedContent,
      });

      console.log(`💬 Call message: ${senderId} -> ${receiverId} in ${roomName} (${originalLanguage} -> ${receiverLang})`);
    } catch (e) {
      console.error('❌ call:message error:', e.message);
      socket.emit('call:message_error', { error: 'send_failed', details: e.message, tempId });
    }
  });

  socket.on("disconnect", async (reason) => {
    // ✅ Disconnect logu
    const userId = socket.data?.userId || 'unknown';
    const gender = socket.data?.gender || 'other';
    console.log(`🔌 Socket disconnected: userId=${userId}, socketId=${socket.id}, reason=${reason}`);

    // ✅ Leave room (cleanup)
    const roomName = `viewer-${gender}`;
    socket.leave(roomName);

    // ✅ Clear gender cache for this socket
    socketGenderCache.delete(socket.id);

    // ✅ PROFESSIONAL: Socket disconnect olduğunda live room'lardan çık ve viewerCount güncelle
    // Socket.io rooms'dan socket'ın hangi live room'larda olduğunu bul
    const socketRooms = Array.from(socket.rooms || []);
    const liveRooms = socketRooms.filter(r => r.startsWith('room_')); // Live stream room'ları 'room_' ile başlar
    
    for (const liveRoomId of liveRooms) {
      try {
        socket.leave(liveRoomId);
        
        // ViewerCount'ı atomic olarak azalt
        const updatedStream = await LiveStream.findOneAndUpdate(
          { roomId: liveRoomId },
          {
            $inc: { viewerCount: -1 },
            $pull: { viewers: userId }
          },
          { new: true }
        ).select('viewerCount host');
        
        if (updatedStream) {
          // ViewerCount negatif olmasın
          if (updatedStream.viewerCount < 0) {
            await LiveStream.updateOne(
              { _id: updatedStream._id },
              { $set: { viewerCount: 0 } }
            );
          }
          
          // Odadaki diğer kullanıcılara bildir
          io.to(liveRoomId).emit('viewer_left', {
            roomId: liveRoomId,
            userId,
            viewerCount: Math.max(0, updatedStream.viewerCount),
            reason: 'disconnect',
            timestamp: Date.now()
          });
          
          console.log(`📺 User ${userId} removed from live room ${liveRoomId} on disconnect (viewerCount: ${Math.max(0, updatedStream.viewerCount)})`);
        }
      } catch (e) {
        console.error(`⚠️ Live room cleanup error for ${liveRoomId}:`, e.message);
      }
    }

    stopServerHeartbeat();
    
    if (!userId || userId === 'unknown') {
      return;
    }

    const key = String(userId).trim();
    const set = userSockets.get(key);
    
    // ✅ FIX: Check if this socket is still in the user's socket set
    // If not, this is a stale disconnect from an old socket - IGNORE IT
    if (!set || !set.has(socket.id)) {
      console.log(`🔒 Ignoring stale disconnect for ${userId} (socket ${socket.id} not in active set)`);
      return;
    }

    set.delete(socket.id);
    
    if (set.size === 0) {
      userSockets.delete(key);

      // ✅ IMMEDIATE OFFLINE: Her türlü disconnect'te HEMEN offline yap
      // Kullanıcı tekrar bağlanmak isterse yeni socket açar
      // Bu sayede diğer kullanıcılar anında offline görür
      try {
        await presenceService.setOffline(userId, { 
          socketId: socket.id, 
          reason: reason || 'disconnect' 
        });
        console.log(`✅ User ${userId} marked offline immediately (reason: ${reason})`);

        // Close any active live streams (separate concern from presence)
        const now = new Date();
        await LiveStream.updateMany(
          { host: userId, isLive: true, status: 'live' },
          { $set: { isLive: false, status: 'ended', endedAt: now } }
        ).catch((err) => console.error('⚠️ LiveStream cleanup failed:', err));

      } catch (err) {
        console.error("❌ Disconnect cleanup error:", err);
      }
    } else {
      userSockets.set(key, set);
    }
  });
});

global.io = io;
global.userSockets = userSockets;
global.activeCalls = activeCalls;
global.pendingCalls = pendingCalls;

// Helper: emit event to all sockets of a user
const emitToUserSockets = (userId, eventName, payload) => {
  const key = String(userId || "").trim();
  if (!key) return false;

  const targetSockets = userSockets.get(key);
  if (!targetSockets || targetSockets.size === 0) {
    console.log(`⚠️ emitToUserSockets - no sockets for user ${key} (event ${eventName})`);
    return false;
  }

  const enrichedPayload = {
    ...payload,
    event: eventName,
    timestamp: Date.now(),
  };

  targetSockets.forEach((sid) => {
    io.to(sid).emit(eventName, enrichedPayload);
  });

  return true;
};

// Helper: find the counterparty of a call by room name
const parseCallRoomName = (roomName) => {
  if (!roomName) return null;
  const parts = String(roomName).split('_');
  if (parts.length < 4 || parts[0] !== 'call') return null;
  const callerId = parts[1];
  const targetUserId = parts[2];
  if (!callerId || !targetUserId) return null;
  return { callerId, targetUserId };
};

const getCounterpartyForRoom = (roomName, senderId) => {
  const senderStr = String(senderId || "").trim();
  if (!senderStr) return null;

  const info = activeCalls.get(roomName);
  if (info) {
    if (senderStr === String(info.callerId)) return String(info.targetUserId);
    if (senderStr === String(info.targetUserId)) return String(info.callerId);
  }

  const parsed = parseCallRoomName(roomName);
  if (parsed) {
    if (senderStr === String(parsed.callerId)) return String(parsed.targetUserId);
    if (senderStr === String(parsed.targetUserId)) return String(parsed.callerId);
  }
  return null;
};

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

// ✅ Security & Performance middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(compression());

// ✅ JSON BODY PARSER
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ✅ CORS - Allowlist based on env
const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// ✅ General API rate limiter
app.use("/api", generalLimiter);

// ROUTES
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/gifts", giftRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/missions", missionRoutes);
app.use("/api/spin", spinRoutes);
app.use("/api/achievements", achievementRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/transactions", transactionRoutes);

// Debug/maintenance endpoints (disabled in production unless explicitly enabled)
if (NODE_ENV !== 'production' || process.env.DEBUG_ROUTES_ENABLED === 'true') {
  if (NODE_ENV === 'production') {
    app.use("/api", authMiddleware, adminMiddleware, debugRoutes);
  } else {
    app.use("/api", debugRoutes);
  }
}

// ✅ HEALTH CHECK ENDPOINT
app.get("/api/health", (req, res) => {
  const metrics = presenceService.getMetrics ? presenceService.getMetrics() : null;
  
  res.json({
    status: "ok",
    message: "EYRA Backend is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: "connected",
    port: PORT,
    presence: metrics ? {
      onlineUsers: metrics.currentOnlineCount,
      peakOnline: metrics.peakOnlineCount,
      totalConnections: metrics.totalConnections,
      totalDisconnections: metrics.totalDisconnections,
      totalSwepts: metrics.totalSweptUsers,
      lastSweepAt: metrics.lastSweepAt ? new Date(metrics.lastSweepAt).toISOString() : null,
      uptimeMs: metrics.uptimeMs,
    } : null,
    sockets: {
      connected: io?.engine?.clientsCount ?? 0,
      connectedUsers: userSockets?.size ?? 0,
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "EYRA Backend is running",
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

// DB + SERVER
connectDB().then(async () => {
  // Connect Redis
  await connectRedis();
  
  // ✅ RESET: Server başlangıcında tüm kullanıcıları offline yap
  // Böylece eski bağlantılar kalıcı olarak kapatılıyor
  try {
    const result = await User.updateMany(
      {},
      {
        $set: {
          isOnline: false,
          isBusy: false,
          isLive: false,
          lastOfflineAt: new Date(),
        }
      }
    );
    console.log(`✅ Server startup: ${result.modifiedCount} kullanıcı offline olarak ayarlandı`);
  } catch (err) {
    console.error('❌ Server startup reset error:', err);
  }
  
  // Initialize presence service
  // ✅ Heartbeat timeout: 15 saniye (client 5 saniyede bir gönderir)
  // ✅ Sweep interval: 3 saniye (stale bağlantıları hızlı temizler)
  presenceService.initialize({
    heartbeatTimeoutMs: Number(process.env.PRESENCE_HEARTBEAT_TIMEOUT_MS || 15000),
    sweepIntervalMs: Number(process.env.PRESENCE_SWEEP_INTERVAL_MS || 3000),
  });
  
  // Bind to all interfaces so LAN devices (Android/Web) can reach the backend
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 EYRA backend ${PORT} portunda çalışıyor (0.0.0.0)`);
  });
});

// =========================
// ✅ GRACEFUL SHUTDOWN
// =========================

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    console.log('⚠️ Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received: Starting graceful shutdown...`);
  
  try {
    // 1. Stop accepting new connections
    console.log('1️⃣ Closing server to new connections...');
    server.close();
    
    // 2. Disconnect all active sockets
    console.log('2️⃣ Disconnecting all active sockets...');
    const socketCount = io.sockets.sockets.size;
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    console.log(`   ✅ ${socketCount} sockets disconnected`);
    
    // 3. Mark all users offline in presence service
    console.log('3️⃣ Marking all users offline...');
    const userCount = userSockets.size;
    for (const userId of userSockets.keys()) {
      try {
        await presenceService.setOffline(userId, { reason: 'server_shutdown' });
      } catch (e) {
        console.error(`   ⚠️ Failed to mark ${userId} offline: ${e.message}`);
      }
    }
    console.log(`   ✅ ${userCount} users marked offline`);
    
    // 4. Cleanup pending DB updates
    console.log('4️⃣ Cleaning up pending DB updates...');
    const pendingCount = pendingDbUpdates.size;
    for (const [userId, { timeoutId }] of pendingDbUpdates.entries()) {
      clearTimeout(timeoutId);
      pendingDbUpdates.delete(userId);
    }
    console.log(`   ✅ ${pendingCount} pending updates cleared`);
    
    // 5. Clear timers
    console.log('5️⃣ Clearing timers...');
    if (staleCleanupTimer) clearInterval(staleCleanupTimer);
    
    // 6. Remove event listeners
    console.log('6️⃣ Removing event listeners...');
    presenceService.off("changed", onPresenceChanged);
    
    // 7. Shutdown presence service
    console.log('7️⃣ Shutting down presence service...');
    presenceService.shutdown();
    
    // 8. Clear caches
    console.log('8️⃣ Clearing caches...');
    socketGenderCache.clear();
    userSockets.clear();
    activeCalls.clear();
    pendingCalls.clear();
    
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
    process.exit(1);
  }
};

// Handle different termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors (but don't shut down immediately)
process.on('uncaughtException', (err) => {
  logger.error('❌ Uncaught Exception:', err);
  // Don't exit - let PM2 or similar handle restarts
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - log and continue
});
// Auto-push test: 22:42:31
