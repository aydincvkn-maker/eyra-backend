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

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

const {
  PORT,
  JWT_SECRET,
  NODE_ENV,
  CLIENT_ORIGIN,
  MOBILE_ORIGIN,
} = require("./config/env");
const connectDB = require("./config/db");
const { connectRedis } = require("./config/redis");
const { logger } = require("./utils/logger");
const User = require("./models/User");
const presenceService = require("./services/presenceService");

// ---- Socket modules ----
const {
  userSockets,
  activeCalls,
  pendingCalls,
  socketGenderCache,
  pendingDbUpdates,
} = require("./socket/state");
const socketHelpers = require("./socket/helpers");
const presenceBroadcast = require("./socket/presenceBroadcast");
const { createAuthMiddleware } = require("./socket/auth");
const connectionHandler = require("./socket/connectionHandler");

// ---- Jobs ----
const presenceSync = require("./jobs/presenceSync");
const cleanupJobs = require("./jobs/cleanup");
const salaryCron = require("./jobs/salaryCron");

// ---- Firebase Admin (push notifications only) ----
const { initFirebaseAdmin } = require("./config/firebaseAdmin");

// ---- Route imports ----
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
const vipRoutes = require("./routes/vipRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const withdrawalRoutes = require("./routes/withdrawalRoutes");
const translateRoutes = require("./routes/translateRoutes");
const adminChatRoutes = require("./routes/adminChatRoutes");
const { generalLimiter } = require("./middleware/rateLimit");
const maintenanceMiddleware = require("./middleware/maintenanceMiddleware");

// =========================
// EXPRESS + HTTP SERVER
// =========================

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

// =========================
// SOCKET.IO SERVER
// =========================

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: false,
  },
  transports: ["polling", "websocket"],
  path: "/socket.io/",
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
    console.log("Redis Adapter connected (Scalable Presence Mode)");
  } catch (err) {
    console.warn("Redis Adapter init failed:", err.message);
  }
}

// Debug mode
if (NODE_ENV === "development") {
  try {
    require("debug")("socket.io:*")();
  } catch (_) {
    console.warn(
      "[DEV] debug paketi yüklü değil, socket.io debug logları devre dışı",
    );
  }
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
const { onPresenceChanged, closeActiveLiveStreamsForHost } =
  presenceSync.setup(io);

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

// ---- Admin socket namespace (/admin) ----
const adminNamespace = require("./socket/adminNamespace");
adminNamespace.setup(io);

// =========================
// EXPRESS MIDDLEWARE & ROUTES
// =========================

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

// HTTP request logging
const morgan = require("morgan");
if (NODE_ENV === "production") {
  app.use(
    morgan("combined", {
      skip: (req) => req.url === "/health" || req.url === "/api/health",
    }),
  );
} else {
  app.use(
    morgan("dev", {
      skip: (req) => req.url === "/health" || req.url === "/api/health",
    }),
  );
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(compression());

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Global NoSQL injection protection
const { sanitizeMongoQuery } = require("./middleware/validate");
app.use(sanitizeMongoQuery);

// Static file serving (uploads)
app.use(
  "/uploads",
  express.static(path.join(__dirname, "../uploads"), {
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  }),
);

// Static file serving (public pages: privacy policy, terms, etc.)
app.use(express.static(path.join(__dirname, "../public")));

// CORS
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

const healthCheckHandler = async (_req, res) => {
  const metrics = presenceService.getMetrics
    ? presenceService.getMetrics()
    : null;
  const mongoose = require("mongoose");
  const { getRedisClient } = require("./config/redis");

  const mongoState = mongoose.connection.readyState;
  const mongoStatus =
    mongoState === 1
      ? "connected"
      : mongoState === 2
        ? "connecting"
        : "disconnected";

  let redisStatus = "unknown";
  try {
    const redis = getRedisClient();
    if (redis && redis.status === "ready") {
      await redis.ping();
      redisStatus = "connected";
    } else {
      redisStatus = redis ? redis.status : "not_initialized";
    }
  } catch {
    redisStatus = "error";
  }

  const isHealthy = mongoStatus === "connected" && redisStatus === "connected";

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "ok" : "degraded",
    message: "EYRA Backend is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoStatus,
    redis: redisStatus,
    port: PORT,
    presence: metrics
      ? {
          onlineUsers: metrics.currentOnlineCount,
          peakOnline: metrics.peakOnlineCount,
          totalConnections: metrics.totalConnections,
          totalDisconnections: metrics.totalDisconnections,
          totalSwepts: metrics.totalSweptUsers,
          lastSweepAt: metrics.lastSweepAt
            ? new Date(metrics.lastSweepAt).toISOString()
            : null,
          uptimeMs: metrics.uptimeMs,
        }
      : null,
    sockets: {
      connected: io?.engine?.clientsCount ?? 0,
      connectedUsers: userSockets?.size ?? 0,
    },
  });
};

// Health check (UptimeRobot / Render ping - no auth, no rate limit, no maintenance check)
app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true, ts: Date.now() }),
);
app.get("/api/health", healthCheckHandler);

// Rate limiter
app.use("/api", generalLimiter);

// Maintenance mode
app.use(maintenanceMiddleware);

// ---- API Routes ----
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
app.use("/api/vip", vipRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/translate", translateRoutes);

// Debug/maintenance endpoints — PRODUCTION'DA TAMAMEN DEVRE DIŞI
if (NODE_ENV !== "production") {
  app.use("/api/debug", authMiddleware, adminMiddleware, debugRoutes);
}

// =========================
// CENTRALIZED ERROR HANDLER
// =========================

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  });
});

// Global error handler middleware
app.use((err, req, res, _next) => {
  // Log the error
  console.error(`❌ [${req.method}] ${req.originalUrl}:`, err.message);
  if (NODE_ENV !== "production") {
    console.error(err.stack);
  }

  // CORS errors
  if (err.message === "Not allowed by CORS") {
    return res
      .status(403)
      .json({ success: false, error: "CORS: Origin not allowed" });
  }

  // Multer file size errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ success: false, error: "File too large" });
  }

  // Mongoose validation errors
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res
      .status(400)
      .json({ success: false, error: "Validation failed", details: messages });
  }

  // Mongoose cast errors (invalid ObjectId etc.)
  if (err.name === "CastError") {
    return res.status(400).json({ success: false, error: "Invalid ID format" });
  }

  // Duplicate key errors
  if (err.code === 11000) {
    return res.status(409).json({ success: false, error: "Duplicate entry" });
  }

  // Default 500
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// =========================
// DB CONNECT + LISTEN
// =========================

connectDB().then(async () => {
  await connectRedis();

  // Reset stale users on startup (sadece uzun süredir heartbeat göndermeyen kullanıcıları offline yap)
  try {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 dakikadır heartbeat yok
    const result = await User.updateMany(
      {
        isOnline: true,
        $or: [
          { lastHeartbeat: { $lt: staleThreshold } },
          { lastHeartbeat: { $exists: false } },
        ],
      },
      {
        $set: {
          isOnline: false,
          isBusy: false,
          isLive: false,
          lastOfflineAt: new Date(),
        },
      },
    );
    console.log(
      "Server startup: " +
        result.modifiedCount +
        " stale kullanici offline olarak ayarlandi",
    );
  } catch (err) {
    console.error("Server startup reset error:", err);
  }

  presenceService.initialize({
    heartbeatTimeoutMs: Number(
      process.env.PRESENCE_HEARTBEAT_TIMEOUT_MS || 15000,
    ),
    sweepIntervalMs: Number(process.env.PRESENCE_SWEEP_INTERVAL_MS || 3000),
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log("EYRA backend " + PORT + " portunda calisiyor (0.0.0.0)");
  });
});

// =========================
// GRACEFUL SHUTDOWN
// =========================

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    console.log("Shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  console.log(signal + " received: Starting graceful shutdown...");

  try {
    // 1. Stop accepting new connections
    server.close();

    // 2. Disconnect all active sockets
    const socketCount = io.sockets.sockets.size;
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    console.log(socketCount + " sockets disconnected");

    // 3. Mark all users offline
    const userCount = userSockets.size;
    for (const userId of userSockets.keys()) {
      try {
        await presenceService.setOffline(userId, { reason: "server_shutdown" });
      } catch (e) {
        console.error("Failed to mark " + userId + " offline: " + e.message);
      }
    }
    console.log(userCount + " users marked offline");

    // 4. Cleanup pending DB updates
    const pendingCount = pendingDbUpdates.size;
    for (const [userId, { timeoutId }] of pendingDbUpdates.entries()) {
      clearTimeout(timeoutId);
      pendingDbUpdates.delete(userId);
    }
    console.log(pendingCount + " pending updates cleared");

    // 5. Clear timers
    if (cleanupTimers.staleCleanupTimer)
      clearInterval(cleanupTimers.staleCleanupTimer);
    if (cleanupTimers.staleLiveCleanupTimer)
      clearInterval(cleanupTimers.staleLiveCleanupTimer);
    if (cleanupTimers.vipExpiryTimer)
      clearInterval(cleanupTimers.vipExpiryTimer);

    // 5b. Stop salary cron
    salaryCron.stop();

    // 6. Remove event listeners
    presenceService.off("changed", onPresenceChanged);

    // 7. Shutdown presence service
    presenceService.shutdown();

    // 8. Clear caches
    socketGenderCache.clear();
    userSockets.clear();
    activeCalls.clear();
    pendingCalls.clear();

    console.log("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception", err);
  // Give logger time to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason) => {
  logger.error(
    "Unhandled Rejection",
    reason instanceof Error ? reason : { reason: String(reason) },
  );
});
