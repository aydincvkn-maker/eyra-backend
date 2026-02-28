/**
 * EYRA Backend - Main Server Entry Point (Orchestrator)
 *
 * This file wires together all modules:
 *  - Express app + middleware + routes
 *  - Socket.io server + auth + connection handler
 *  - Presence sync + cleanup jobs
 *  - Graceful shutdown
 *
 * Business logic lives in:
 *  - src/socket/   (state, helpers, auth, handlers)
 *  - src/jobs/     (cleanup, presenceSync)
 *  - src/services/ (presenceService, liveService, etc.)
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

const { PORT, JWT_SECRET, NODE_ENV, CLIENT_ORIGIN, MOBILE_ORIGIN } = require('./config/env');
const connectDB = require('./config/db');
const { connectRedis } = require('./config/redis');
const { logger } = require('./utils/logger');
const User = require('./models/User');
const presenceService = require('./services/presenceService');

// ---- Socket modules ----
const { userSockets, activeCalls, pendingCalls, socketGenderCache, pendingDbUpdates } = require('./socket/state');
const socketHelpers = require('./socket/helpers');
const presenceBroadcast = require('./socket/presenceBroadcast');
const { createAuthMiddleware } = require('./socket/auth');
const connectionHandler = require('./socket/connectionHandler');

// ---- Jobs ----
const presenceSync = require('./jobs/presenceSync');
const cleanupJobs = require('./jobs/cleanup');
const salaryCron = require('./jobs/salaryCron');

// ---- Firebase Admin (push notifications only) ----
const { initFirebaseAdmin } = require('./config/firebaseAdmin');

// ---- Route imports ----
const authRoutes = require('./routes/authRoutes');
const authMiddleware = require('./middleware/auth');
const adminMiddleware = require('./middleware/admin');
const userRoutes = require('./routes/userRoutes');
const liveRoutes = require('./routes/liveRoutes');
const giftRoutes = require('./routes/giftRoutes');
const chatRoutes = require('./routes/chatRoutes');
const reportRoutes = require('./routes/reportRoutes');
const statsRoutes = require('./routes/statsRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const callRoutes = require('./routes/callRoutes');
const debugRoutes = require('./routes/debugRoutes');
const supportRoutes = require('./routes/supportRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const missionRoutes = require('./routes/missionRoutes');
const spinRoutes = require('./routes/spinRoutes');
const achievementRoutes = require('./routes/achievementRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const vipRoutes = require('./routes/vipRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const withdrawalRoutes = require('./routes/withdrawalRoutes');
const { generalLimiter } = require('./middleware/rateLimit');
const maintenanceMiddleware = require('./middleware/maintenanceMiddleware');

// =========================
// EXPRESS + HTTP SERVER
// =========================

const app = express();
const server = http.createServer(app);

const parseOrigins = (value) => {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const allowedOrigins = new Set([
  ...parseOrigins(CLIENT_ORIGIN),
  ...parseOrigins(MOBILE_ORIGIN),
]);

const isOriginAllowed = (origin) => {
  if (!origin) return true; // non-browser clients
  if (allowedOrigins.has('*')) return true;
  return allowedOrigins.has(origin);
};

// =========================
// SOCKET.IO SERVER
// =========================

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: false,
  },
  transports: ['polling', 'websocket'],
  path: '/socket.io/',
  serveClient: false,
  pingInterval: 25000,
  pingTimeout: 120000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
});

// Redis Adapter for multi-instance support
if (process.env.REDIS_HOST) {
  try {
    const pubClient = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    });
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Redis Adapter connected (Scalable Presence Mode)');
  } catch (err) {
    console.warn('Redis Adapter init failed:', err.message);
  }
}

// Debug mode
if (NODE_ENV === 'development') {
  require('debug')('socket.io:*')();
}

// ---- Initialize socket modules with io reference ----
socketHelpers.init(io);
presenceBroadcast.init(io);

// ---- Globals for backward compatibility (callController, etc.) ----
global.io = io;
global.userSockets = userSockets;
global.activeCalls = activeCalls;
global.pendingCalls = pendingCalls;

// ---- Presence sync (DB + live auto-end) ----
const { onPresenceChanged, closeActiveLiveStreamsForHost } = presenceSync.setup(io);

// ---- Cleanup jobs ----
const cleanupTimers = cleanupJobs.startAll(io, closeActiveLiveStreamsForHost);

// ---- Salary cron (Her Pazartesi 00:05 UTC) ----
salaryCron.start();

// ---- Firebase Admin SDK (push bildirimleri için) ----
initFirebaseAdmin();

// ---- Socket auth middleware ----
io.use(createAuthMiddleware());

// ---- Socket connection handler ----
connectionHandler.setup(io);

// =========================
// EXPRESS MIDDLEWARE & ROUTES
// =========================

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(compression());

app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf ? buf.toString('utf8') : '';
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Static file serving (uploads)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Rate limiter
app.use('/api', generalLimiter);

// Maintenance mode
app.use(maintenanceMiddleware);

// ---- API Routes ----
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/gifts', giftRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/spin', spinRoutes);
app.use('/api/achievements', achievementRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/vip', vipRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/withdrawals', withdrawalRoutes);

// Debug/maintenance endpoints
if (NODE_ENV !== 'production' || process.env.DEBUG_ROUTES_ENABLED === 'true') {
  const allowPublicDebugInDev =
    NODE_ENV !== 'production' && process.env.ALLOW_PUBLIC_DEBUG_ROUTES === 'true';

  if (NODE_ENV === 'production' || !allowPublicDebugInDev) {
    app.use('/api/debug', authMiddleware, adminMiddleware, debugRoutes);
  } else {
    app.use('/api/debug', debugRoutes);
  }
}

// ---- Health check ----
app.get('/api/health', (req, res) => {
  const metrics = presenceService.getMetrics ? presenceService.getMetrics() : null;

  res.json({
    status: 'ok',
    message: 'EYRA Backend is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: 'connected',
    port: PORT,
    presence: metrics
      ? {
          onlineUsers: metrics.currentOnlineCount,
          peakOnline: metrics.peakOnlineCount,
          totalConnections: metrics.totalConnections,
          totalDisconnections: metrics.totalDisconnections,
          totalSwepts: metrics.totalSweptUsers,
          lastSweepAt: metrics.lastSweepAt ? new Date(metrics.lastSweepAt).toISOString() : null,
          uptimeMs: metrics.uptimeMs,
        }
      : null,
    sockets: {
      connected: io?.engine?.clientsCount ?? 0,
      connectedUsers: userSockets?.size ?? 0,
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'EYRA Backend is running',
    timestamp: new Date().toISOString(),
    port: PORT,
  });
});

// =========================
// DB CONNECT + LISTEN
// =========================

connectDB().then(async () => {
  await connectRedis();

  // Reset all users offline on startup
  try {
    const result = await User.updateMany(
      {},
      {
        $set: {
          isOnline: false,
          isBusy: false,
          isLive: false,
          lastOfflineAt: new Date(),
        },
      },
    );
    console.log('Server startup: ' + result.modifiedCount + ' kullanici offline olarak ayarlandi');
  } catch (err) {
    console.error('Server startup reset error:', err);
  }

  presenceService.initialize({
    heartbeatTimeoutMs: Number(process.env.PRESENCE_HEARTBEAT_TIMEOUT_MS || 15000),
    sweepIntervalMs: Number(process.env.PRESENCE_SWEEP_INTERVAL_MS || 3000),
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('EYRA backend ' + PORT + ' portunda calisiyor (0.0.0.0)');
  });
});

// =========================
// GRACEFUL SHUTDOWN
// =========================

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  console.log(signal + ' received: Starting graceful shutdown...');

  try {
    // 1. Stop accepting new connections
    server.close();

    // 2. Disconnect all active sockets
    const socketCount = io.sockets.sockets.size;
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    console.log(socketCount + ' sockets disconnected');

    // 3. Mark all users offline
    const userCount = userSockets.size;
    for (const userId of userSockets.keys()) {
      try {
        await presenceService.setOffline(userId, { reason: 'server_shutdown' });
      } catch (e) {
        console.error('Failed to mark ' + userId + ' offline: ' + e.message);
      }
    }
    console.log(userCount + ' users marked offline');

    // 4. Cleanup pending DB updates
    const pendingCount = pendingDbUpdates.size;
    for (const [userId, { timeoutId }] of pendingDbUpdates.entries()) {
      clearTimeout(timeoutId);
      pendingDbUpdates.delete(userId);
    }
    console.log(pendingCount + ' pending updates cleared');

    // 5. Clear timers
    if (cleanupTimers.staleCleanupTimer) clearInterval(cleanupTimers.staleCleanupTimer);
    if (cleanupTimers.staleLiveCleanupTimer) clearInterval(cleanupTimers.staleLiveCleanupTimer);
    if (cleanupTimers.vipExpiryTimer) clearInterval(cleanupTimers.vipExpiryTimer);

    // 5b. Stop salary cron
    salaryCron.stop();

    // 6. Remove event listeners
    presenceService.off('changed', onPresenceChanged);

    // 7. Shutdown presence service
    presenceService.shutdown();

    // 8. Clear caches
    socketGenderCache.clear();
    userSockets.clear();
    activeCalls.clear();
    pendingCalls.clear();

    console.log('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
