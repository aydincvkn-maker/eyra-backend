/**
 * /admin Socket.IO namespace — real-time events for admin panel.
 * Auth: JWT + role check (admin | superadmin).
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const User = require("../models/User");

let adminNsp = null;
const adminUserSockets = new Map();

function addAdminSocket(userId, socketId) {
  const key = String(userId || "").trim();
  if (!key) return;
  const existing = adminUserSockets.get(key) || new Set();
  existing.add(socketId);
  adminUserSockets.set(key, existing);
}

function removeAdminSocket(userId, socketId) {
  const key = String(userId || "").trim();
  if (!key) return;
  const existing = adminUserSockets.get(key);
  if (!existing) return;
  existing.delete(socketId);
  if (existing.size === 0) {
    adminUserSockets.delete(key);
  }
}

function emitToAdminUser(userId, event, payload) {
  const key = String(userId || "").trim();
  if (!adminNsp || !key) return false;

  const socketIds = adminUserSockets.get(key);
  if (!socketIds || socketIds.size === 0) return false;

  socketIds.forEach((socketId) => {
    adminNsp.to(socketId).emit(event, { ...payload, _ts: Date.now() });
  });
  return true;
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
  adminNsp.on("connection", (socket) => {
    console.log(`🛡️  Admin socket connected: ${socket.data.username} (${socket.data.role})`);
    addAdminSocket(socket.data.userId, socket.id);

    // Admin chat: yazıyor göstergesi
    socket.on("admin-chat:typing", () => {
      socket.broadcast.emit("admin-chat:typing", {
        userId: socket.data.userId,
        username: socket.data.username,
        _ts: Date.now(),
      });
    });

    socket.on("admin-call:initiate", ({ targetUserId, callId, offer }) => {
      const targetId = String(targetUserId || "").trim();
      if (!targetId || targetId === socket.data.userId || !callId || !offer) return;

      const delivered = emitToAdminUser(targetId, "admin-call:incoming", {
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

    socket.on("admin-call:answer", ({ targetUserId, callId, answer }) => {
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId || !answer) return;
      emitToAdminUser(targetId, "admin-call:answered", {
        callId,
        answer,
        responderId: socket.data.userId,
        responderName: socket.data.username,
      });
    });

    socket.on("admin-call:ice-candidate", ({ targetUserId, callId, candidate }) => {
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId || !candidate) return;
      emitToAdminUser(targetId, "admin-call:ice-candidate", {
        callId,
        candidate,
        senderId: socket.data.userId,
      });
    });

    socket.on("admin-call:reject", ({ targetUserId, callId }) => {
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId) return;
      emitToAdminUser(targetId, "admin-call:rejected", {
        callId,
        responderId: socket.data.userId,
        responderName: socket.data.username,
      });
    });

    socket.on("admin-call:end", ({ targetUserId, callId, reason }) => {
      const targetId = String(targetUserId || "").trim();
      if (!targetId || !callId) return;
      emitToAdminUser(targetId, "admin-call:ended", {
        callId,
        reason: reason || "ended",
        senderId: socket.data.userId,
      });
    });

    socket.on("disconnect", () => {
      removeAdminSocket(socket.data.userId, socket.id);
      console.log(`🛡️  Admin socket disconnected: ${socket.data.username}`);
    });
  });

  console.log("🛡️  Admin socket namespace /admin ready");
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

module.exports = { setup, emit, emitToAdminUser, getNsp };
