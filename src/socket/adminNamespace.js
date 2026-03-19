/**
 * /admin Socket.IO namespace — real-time events for admin panel.
 * Auth: JWT + role check (admin | superadmin).
 */

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const User = require("../models/User");

let adminNsp = null;

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

    // Admin chat: yazıyor göstergesi
    socket.on("admin-chat:typing", () => {
      socket.broadcast.emit("admin-chat:typing", {
        userId: socket.data.userId,
        username: socket.data.username,
        _ts: Date.now(),
      });
    });

    socket.on("disconnect", () => {
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

module.exports = { setup, emit, getNsp };
