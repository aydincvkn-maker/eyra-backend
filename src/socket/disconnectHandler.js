/**
 * Socket disconnect handler.
 * Cleans up live rooms, presence, user socket map, and heartbeat timer.
 */

const { userSockets, socketGenderCache } = require('./state');
const LiveStream = require('../models/LiveStream');
const presenceService = require('../services/presenceService');
const { logger } = require('../utils/logger');

/**
 * Register the disconnect handler on a connected socket.
 * @param {Socket}   socket             - The connected Socket.io socket
 * @param {Server}   io                 - The Socket.io server instance
 * @param {Function} stopServerHeartbeat - Cleanup function for the per-socket heartbeat timer
 */
function register(socket, io, stopServerHeartbeat) {
  socket.on('disconnect', async (reason) => {
    const userId = socket.data?.userId || 'unknown';
    const gender = socket.data?.gender || 'other';
    console.log(`🔌 Socket disconnected: userId=${userId}, socketId=${socket.id}, reason=${reason}`);

    // Leave gender room
    const roomName = `viewer-${gender}`;
    socket.leave(roomName);

    // Clear gender cache
    socketGenderCache.delete(socket.id);

    // Live room cleanup: update viewerCount for any live rooms this socket was in
    const socketRooms = Array.from(socket.rooms || []);
    const liveRooms = socketRooms.filter((r) => r.startsWith('room_'));

    for (const liveRoomId of liveRooms) {
      try {
        socket.leave(liveRoomId);

        const updatedStream = await LiveStream.findOneAndUpdate(
          { roomId: liveRoomId },
          {
            $inc: { viewerCount: -1 },
            $pull: { viewers: userId },
          },
          { new: true },
        ).select('viewerCount host');

        if (updatedStream) {
          if (updatedStream.viewerCount < 0) {
            await LiveStream.updateOne(
              { _id: updatedStream._id },
              { $set: { viewerCount: 0 } },
            );
          }

          io.to(liveRoomId).emit('viewer_left', {
            roomId: liveRoomId,
            userId,
            viewerCount: Math.max(0, updatedStream.viewerCount),
            reason: 'disconnect',
            timestamp: Date.now(),
          });

          console.log(`📺 User ${userId} removed from live room ${liveRoomId} on disconnect (viewerCount: ${Math.max(0, updatedStream.viewerCount)})`);
        }
      } catch (e) {
        console.error(`⚠️ Live room cleanup error for ${liveRoomId}:`, e.message);
      }
    }

    // Stop per-socket heartbeat
    stopServerHeartbeat();

    if (!userId || userId === 'unknown') {
      return;
    }

    const key = String(userId).trim();
    const set = userSockets.get(key);

    // Ignore stale disconnect from old socket
    if (!set || !set.has(socket.id)) {
      console.log(`🔒 Ignoring stale disconnect for ${userId} (socket ${socket.id} not in active set)`);
      return;
    }

    set.delete(socket.id);

    if (set.size === 0) {
      userSockets.delete(key);

      // Immediate offline
      try {
        await presenceService.setOffline(userId, {
          socketId: socket.id,
          reason: reason || 'disconnect',
        });
        console.log(`✅ User ${userId} marked offline immediately (reason: ${reason})`);

        // Close any active live streams
        const now = new Date();
        await LiveStream.updateMany(
          { host: userId, isLive: true, status: 'live' },
          { $set: { isLive: false, status: 'ended', endedAt: now } },
        ).catch((err) => console.error('⚠️ LiveStream cleanup failed:', err));
      } catch (err) {
        console.error('❌ Disconnect cleanup error:', err);
      }
    } else {
      userSockets.set(key, set);
    }
  });
}

module.exports = { register };
