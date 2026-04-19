/**
 * /admin Socket.IO namespace — real-time events for admin panel.
 * Auth: JWT + role check (admin | superadmin).
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const User = require("../models/User");
const { sanitizeSocketPayload } = require("../middleware/validate");
const { logger } = require("../utils/logger");

let adminNsp = null;

function getAdminUserRoom(userId) {
  const key = String(userId || "").trim();
  return key ? `admin-user:${key}` : null;
}

async function getConnectedAdminIds() {
  if (!adminNsp) return [];

  const sockets = await adminNsp.fetchSockets();
  return Array.from(
    new Set(
      sockets
        .map((socket) => String(socket.data?.userId || "").trim())
        .filter(Boolean),
    ),
  );
}

async function getAdminSocketCount(userId) {
  const key = String(userId || "").trim();
  const room = getAdminUserRoom(key);
  if (!adminNsp || !room) return 0;

  const sockets = await adminNsp.in(room).fetchSockets();
  return sockets.length;
}

async function emitToAdminUser(userId, event, payload) {
  const key = String(userId || "").trim();
  const room = getAdminUserRoom(key);
  if (!adminNsp || !room) return false;

  const socketCount = await getAdminSocketCount(key);
  if (socketCount === 0) return false;

  adminNsp.to(room).emit(event, { ...payload, _ts: Date.now() });
  return true;
}

async function emitAdminPresenceSnapshot(socket) {
  if (!socket) return;

  socket.emit("admin-presence:snapshot", {
    onlineAdminIds: await getConnectedAdminIds(),
    _ts: Date.now(),
  });
}

function broadcastAdminPresenceUpdate(userId, isOnline, excludedSocketId = null) {
  if (!adminNsp) return;

  const payload = {
    userId: String(userId || "").trim(),
    isOnline: Boolean(isOnline),
    _ts: Date.now(),
  };

  if (!payload.userId) return;

  if (excludedSocketId) {
    adminNsp.except(excludedSocketId).emit("admin-presence:update", payload);
    return;
  }

  adminNsp.emit("admin-presence:update", payload);
}

/** Initialise the /admin namespace on the given io instance. */
function setup(io) {
  adminNsp = io.of("/admin");

  // ── Auth middleware ──
  adminNsp.use(async (socket, next) => {
    try {
      const token =
        socket.handshake?.auth?.token ||
        (socket.handshake?.headers?.authorization || "").replace(/^bearer\s+/i, "") ||
        socket.handshake?.query?.token;

      if (!token) return next(new Error("Missing token"));

      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = String(decoded?.id || "").trim();
      if (!userId) return next(new Error("Invalid token"));

      const user = await User.findById(userId).select("_id role username isBanned").lean();
      if (!user || user.isBanned) return next(new Error("Unauthorized"));
      if (!["admin", "super_admin", "moderator"].includes(user.role)) return next(new Error("Forbidden"));

      socket.data.userId = String(user._id);
      socket.data.role = user.role;
      socket.data.username = user.username;
      next();
    } catch (err) {
      next(new Error("Unauthorized"));
    }
  });

  // ── Connection handler ──
  adminNsp.on("connection", async (socket) => {
    logger.info('Admin socket connected', { username: socket.data.username, role: socket.data.role });

    const adminRoom = getAdminUserRoom(socket.data.userId);
    if (adminRoom) {
      await socket.join(adminRoom);
    }

    await emitAdminPresenceSnapshot(socket);
    if ((await getAdminSocketCount(socket.data.userId)) === 1) {
      broadcastAdminPresenceUpdate(socket.data.userId, true, socket.id);
    }

    // Admin chat: yazıyor göstergesi
    socket.on("admin-chat:typing", async (rawData = {}) => {
      const data = sanitizeSocketPayload(rawData);
      const rawRecipientId = String(data.recipientId || "").trim();
      const threadType = rawRecipientId ? "direct" : "group";
      const payload = {
        userId: socket.data.userId,
        username: socket.data.username,
        threadType,
        recipientId: rawRecipientId || null,
        _ts: Date.now(),
      };

      if (threadType === "direct") {
        if (!rawRecipientId || rawRecipientId === socket.data.userId) return;
        await emitToAdminUser(rawRecipientId, "admin-chat:typing", payload);
        return;
      }

      socket.broadcast.emit("admin-chat:typing", payload);
    });

    socket.on("admin-call:initiate", async (rawData) => {
      const { targetUserId, callId, offer } = sanitizeSocketPayload(rawData);
      const targetId = String(targetUserId || "").trim();
      if (!targetId || targetId === socket.data.userId || !callId || !offer) return;

      const delivered = await emitToAdminUser(targetId, "admin-call:incoming", {
        callId,
        callerId: socket.data.userId,
        callerName: socket.data.username,
        offer,
      });

      if (!delivered) {
        socket.emit("admin-call:unavailable", {
          callId,
          targetUserId: targetId,
          _ts: Date.now(),
        });
      }
    });

    socket.on("admin-call:answer", async (rawData) => {
      const { targetUserId, callId, answer } = sanitizeSocketPayload(rawData);
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId || !answer) return;
      await emitToAdminUser(targetId, "admin-call:answered", {
        callId,
        answer,
        responderId: socket.data.userId,
        responderName: socket.data.username,
      });
    });

    socket.on("admin-call:ice-candidate", async (rawData) => {
      const { targetUserId, callId, candidate } = sanitizeSocketPayload(rawData);
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId || !candidate) return;
      await emitToAdminUser(targetId, "admin-call:ice-candidate", {
        callId,
        candidate,
        senderId: socket.data.userId,
      });
    });

    socket.on("admin-call:reject", async (rawData) => {
      const { targetUserId, callId } = sanitizeSocketPayload(rawData);
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId) return;
      await emitToAdminUser(targetId, "admin-call:rejected", {
        callId,
        responderId: socket.data.userId,
        responderName: socket.data.username,
      });
    });

    socket.on("admin-call:end", async (rawData) => {
      const { targetUserId, callId, reason } = sanitizeSocketPayload(rawData);
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId) return;
      await emitToAdminUser(targetId, "admin-call:ended", {
        callId,
        reason: reason || "ended",
        senderId: socket.data.userId,
      });
    });

    socket.on("disconnect", async () => {
      if ((await getAdminSocketCount(socket.data.userId)) === 0) {
        broadcastAdminPresenceUpdate(socket.data.userId, false);
      }
      logger.info('Admin socket disconnected', { username: socket.data.username });
    });
  });

  logger.info('Admin socket namespace /admin ready');
  return adminNsp;
}

/**
 * Emit an event to all connected admin sockets.
 * Safe to call even before setup() — silently no-ops.
 *
 * @param {string} event  Event name, e.g. "stream:started"
 * @param {object} data   Payload
 */
function emit(event, data) {
  if (!adminNsp) return;
  adminNsp.emit(event, { ...data, _ts: Date.now() });
}

/** Return the namespace instance (or null) */
function getNsp() {
  return adminNsp;
}

module.exports = {
  setup,
  emit,
  emitToAdminUser,
  getNsp,
  getConnectedAdminIds,
};
