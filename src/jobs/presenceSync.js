/**
 * Presence <-> Database sync and live stream auto-end on offline.
 * Call setup(io) once after Socket.io is ready. Returns cleanup helpers.
 */

const mongoose = require('mongoose');
const { pendingDbUpdates } = require('../socket/state');
const { emitPresenceUpdateToVisibleSockets } = require('../socket/presenceBroadcast');
const presenceService = require('../services/presenceService');
const liveService = require('../services/liveService');
const User = require('../models/User');
const LiveStream = require('../models/LiveStream');
const { logger } = require('../utils/logger');

const DB_SYNC_DEBOUNCE_MS = 2000;

// ---- Persist presence to DB (debounced) ----
const persistPresenceToDatabase = async (payload = {}) => {
  const userId = String(payload.userId || '').trim();
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
    presenceStatus: presence.status || (isOnline ? 'online' : 'offline'),
  };

  if (isOnline) {
    update.lastOnlineAt = now;
  } else {
    update.lastOfflineAt = now;
  }

  // Cancel previous pending update for same user
  const pending = pendingDbUpdates.get(userId);
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
  }

  // Immediate for offline (0ms), debounced for online
  const delayMs = isOnline ? DB_SYNC_DEBOUNCE_MS : 0;

  const timeoutId = setTimeout(async () => {
    try {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        console.warn(`⚠️ Invalid userId format for DB sync: ${userId}`);
        return;
      }

      const objectId = new mongoose.Types.ObjectId(userId);
      const result = await User.updateOne({ _id: objectId }, { $set: update });

      if (result.modifiedCount > 0) {
        console.log(`🔄 Presence DB sync: ${userId} -> ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
      }
    } catch (err) {
      logger.warn(`⚠️ Presence DB sync failed for ${userId}: ${err.message}`);
    } finally {
      pendingDbUpdates.delete(userId);
    }
  }, delayMs);

  pendingDbUpdates.set(userId, { update, timeoutId });
};

// ---- Close active live stream when host goes offline ----
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

    // Remove sockets from room
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

/**
 * Set up the presence event listener.
 * @param {Server} io - Socket.io server (unused directly but kept for future)
 * @returns {{ onPresenceChanged, closeActiveLiveStreamsForHost }}
 */
function setup(io) {
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

    // 3. Live stream cleanup: host offline → auto-end
    if (String(status) === 'offline') {
      const reason = payload?.meta?.reason || 'presence_offline';
      closeActiveLiveStreamsForHost(userId, reason).catch((e) => {
        logger.warn(`⚠️ Live auto-end failed for ${userId}: ${e.message}`);
      });
    }
  };

  presenceService.on('changed', onPresenceChanged);

  return { onPresenceChanged, closeActiveLiveStreamsForHost };
}

module.exports = { setup, closeActiveLiveStreamsForHost };
