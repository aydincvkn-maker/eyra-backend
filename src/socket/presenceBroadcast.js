/**
 * Presence broadcast helpers (gender-filtered).
 * Call init(io) once before use.
 */

const presenceService = require('../services/presenceService');
const { canSeeTarget } = require('./helpers');
const { logger } = require('../utils/logger');

let _io = null;

function init(io) {
  _io = io;
}

/**
 * Broadcast a single user's presence update to all visible sockets (room-based).
 * Male viewers only see female targets; female/other see everyone.
 */
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

  try {
    if (targetGender === 'female') {
      // Female users visible to everyone
      _io.to('viewer-male').to('viewer-female').to('viewer-other').emit('presence-update', payload);
    } else {
      // Male/other users only visible to female/other viewers
      _io.to('viewer-female').to('viewer-other').emit('presence-update', payload);
    }

    // DEBUG log (only in dev, sampled)
    if (process.env.NODE_ENV === 'development' && Math.random() < 0.01) {
      console.log(`📡 Presence broadcast: ${userId} -> ${status} (rooms: ${targetGender === 'female' ? 'all' : 'female+other'})`);
    }
  } catch (e) {
    logger.error('❌ Presence broadcast error:', e);
  }
};

/**
 * Send a one-time batch snapshot of all visible online users to a single socket.
 * Used on connect/register so clients can render presence immediately.
 */
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

module.exports = {
  init,
  emitPresenceUpdateToVisibleSockets,
  emitAllVisiblePresenceToSocket,
};
