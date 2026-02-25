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
    console.log('❌ Socket connection error:', err.req?.url, err.code, err.message, err.context);
  });

  io.engine.on('initial_headers', (headers, req) => {
    if (process.env.DEBUG_SOCKET_HANDSHAKE === 'true') {
      console.log('📡 New socket handshake request:', req.url);
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data?.userId || 'unknown';
    const gender = socket.data?.gender || 'other';
    console.log(`✅ Socket connected: userId=${userId}, socketId=${socket.id}, gender=${gender}`);

    // Join gender-based room for efficient broadcasting
    const roomName = `viewer-${gender}`;
    socket.join(roomName);
    console.log(`📡 Socket ${socket.id} joined room: ${roomName}`);

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

        console.log(`\n✅ SOCKET REGISTERED`);
        console.log(`   userId: "${uid}" (type: ${typeof uid}, length: ${uid.length})`);
        console.log(`   socketId: ${socket.id}`);
        console.log(`   Old sockets to cleanup: ${oldSocketIds.length}`);
        console.log(`   Total users in map: ${userSockets.size}`);
        console.log(
          `   Map keys: ${Array.from(userSockets.keys())
            .map((k) => `"${k}"`)
            .join(', ')}\n`,
        );

        await presenceService.setOnline(uid, {
          socketId: socket.id,
          gender: socket.data.gender,
        });

        isRegistered = true;
        registrationInProgress = false;

        if (oldSocketIds.length > 0) {
          console.log(`ℹ️ Old sockets removed from map (will timeout): ${oldSocketIds.join(', ')}`);
        }
      } catch (err) {
        console.error('❌ presence setOnline error:', err.message);
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
        console.error('❌ Pending call delivery error:', e);
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
    socket.on('user:set_status', async (status) => {
      try {
        const uid = socket.data.userId;
        if (!uid) return;
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
