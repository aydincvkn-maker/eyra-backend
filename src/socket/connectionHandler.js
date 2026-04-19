/**
 * Main Socket.io connection handler.
 * Orchestrates per-socket setup: registration, heartbeat, gender rooms,
 * and delegates to feature-specific handler modules.
 */

const { userSockets, pendingCalls } = require('./state');
const { emitToUserSockets } = require('./helpers');
const { emitAllVisiblePresenceToSocket } = require('./presenceBroadcast');
const presenceService = require('../services/presenceService');
const { logger } = require('../utils/logger');
const { sanitizeSocketPayload } = require('../middleware/validate');

const liveHandlers = require('./liveHandlers');
const callHandlers = require('./callHandlers');
const chatHandlers = require('./chatHandlers');
const disconnectHandler = require('./disconnectHandler');

/**
 * Attach the main connection handler to the Socket.io server.
 * @param {Server} io - The Socket.io server instance
 */
function setup(io) {
  // Debug hooks
  io.engine.on('connection_error', (err) => {
    logger.error('Socket connection error', { url: err.req?.url, code: err.code, err: err.message });
  });

  io.engine.on('initial_headers', (headers, req) => {
    if (process.env.DEBUG_SOCKET_HANDSHAKE === 'true') {
      logger.debug('New socket handshake request', { url: req.url });
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data?.userId || 'unknown';
    const gender = socket.data?.gender || 'other';
    logger.info('Socket connected', { userId, socketId: socket.id, gender });

    // Join gender-based room for efficient broadcasting
    const roomName = `viewer-${gender}`;
    socket.join(roomName);
    logger.debug(`Socket ${socket.id} joined room: ${roomName}`);

    // ---- Per-socket heartbeat timer ----
    let serverHeartbeatTimer = null;

    const stopServerHeartbeat = () => {
      if (serverHeartbeatTimer) {
        clearInterval(serverHeartbeatTimer);
        serverHeartbeatTimer = null;
      }
    };

    const startServerHeartbeat = () => {
      stopServerHeartbeat();

      const enableServerHeartbeat =
        String(process.env.PRESENCE_ENABLE_SERVER_HEARTBEAT || 'false').toLowerCase() === 'true';
      if (!enableServerHeartbeat) return;

      const uid = String(socket.data.userId || '').trim();
      if (!uid) return;

      const intervalMs = Number(process.env.PRESENCE_SERVER_HEARTBEAT_INTERVAL_MS || 10_000);
      const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 1_000 ? intervalMs : 10_000;

      serverHeartbeatTimer = setInterval(() => {
        try {
          presenceService.heartbeat(uid, { socketId: socket.id });
        } catch (_) {
          // ignore
        }
      }, safeIntervalMs);

      if (typeof serverHeartbeatTimer.unref === 'function') {
        serverHeartbeatTimer.unref();
      }
    };

    // ---- Registration logic ----
    let isRegistered = false;
    let registrationInProgress = false;

    const registerUser = async () => {
      const uid = String(socket.data.userId || '').trim();
      if (!uid) return;

      if (isRegistered || registrationInProgress) {
        logger.info(`🔄 User ${uid} already registered or registration in progress, skipping`);
        return;
      }

      registrationInProgress = true;

      try {
        // Opt-in: kick different user on same IP
        const kickDifferentUserSameIP =
          String(process.env.SOCKET_KICK_DIFFERENT_USER_SAME_IP || 'false').toLowerCase() === 'true';
        if (kickDifferentUserSameIP) {
          const clientIP =
            socket.handshake?.address || socket.request?.connection?.remoteAddress || '';
          for (const [existingUserId, socketSet] of userSockets.entries()) {
            if (existingUserId === uid) continue;

            for (const sid of socketSet) {
              const existingSocket = io.sockets.sockets.get(sid);
              if (!existingSocket) continue;

              const existingIP =
                existingSocket.handshake?.address ||
                existingSocket.request?.connection?.remoteAddress ||
                '';
              if (existingIP === clientIP && clientIP !== '') {
                console.log(
                  `🔄 Same IP different user: ${existingUserId} -> ${uid}. Disconnecting old socket (opt-in).`,
                );

                try {
                  await presenceService.setOffline(existingUserId, {
                    socketId: sid,
                    reason: 'new_user_same_ip',
                  });
                } catch (e) {
                  logger.warn(`Old user offline failed: ${e.message}`);
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

        // Enforce single socket per user
        const existing = userSockets.get(uid) || new Set();
        const oldSocketIds = [];
        for (const sid of existing) {
          if (sid !== socket.id) {
            oldSocketIds.push(sid);
          }
        }

        // Update map with ONLY the new socket
        const onlyThis = new Set([socket.id]);
        userSockets.set(uid, onlyThis);

        logger.info('Socket registered', { userId: uid, socketId: socket.id, oldSockets: oldSocketIds.length, totalUsers: userSockets.size });

        await presenceService.setOnline(uid, {
          socketId: socket.id,
          gender: socket.data.gender,
        });

        isRegistered = true;
        registrationInProgress = false;

        if (oldSocketIds.length > 0) {
          logger.debug('Old sockets removed from map', { sockets: oldSocketIds });
        }
      } catch (err) {
        logger.error('presence setOnline error', { err: err.message });
        registrationInProgress = false;
        throw err;
      }

      // Initial batch snapshot
      await emitAllVisiblePresenceToSocket(socket);

      // Start server-side heartbeat
      startServerHeartbeat();

      // Deliver pending calls queued while this user was offline
      try {
        const queued = pendingCalls.get(uid);
        if (queued && Array.isArray(queued) && queued.length > 0) {
          queued.forEach((c) => {
            emitToUserSockets(uid, 'incoming_call', {
              callerId: c.callerId,
              callerName: c.callerName,
              roomName: c.roomName,
            });
          });
          pendingCalls.delete(uid);
        }
      } catch (e) {
        logger.error('Pending call delivery error', { err: String(e) });
      }
    };

    // Register immediately on connect (JWT-authenticated)
    registerUser();

    // Backward compatible: ignore userId argument, just ensure registration
    socket.on('register', async () => {
      await registerUser();
    });

    // ---- Heartbeat events ----
    const onHeartbeat = async () => {
      try {
        const uid = socket.data.userId;
        if (!uid) return;
        await presenceService.heartbeat(uid, { socketId: socket.id, gender: socket.data.gender });
      } catch (e) {
        logger.error(`❌ Heartbeat error for socket ${socket.id}:`, e);
      }
    };

    socket.on('user:heartbeat', onHeartbeat);
    socket.on('presence:ping', onHeartbeat);

    // Status changes (live / in_call / online)
    socket.on('user:set_status', async (rawStatus) => {
      try {
        const uid = socket.data.userId;
        if (!uid) return;
        const status = typeof rawStatus === 'string' ? rawStatus : String(rawStatus || '');
        await presenceService.setStatus(uid, status, {
          socketId: socket.id,
          gender: socket.data.gender,
        });
      } catch (e) {
        logger.error(`❌ Set status error for socket ${socket.id}:`, e);
      }
    });

    // ---- Delegate to feature handlers ----
    liveHandlers.register(socket, io);
    callHandlers.register(socket, io);
    chatHandlers.register(socket, io);
    disconnectHandler.register(socket, io, stopServerHeartbeat);
  });
}

module.exports = { setup };
