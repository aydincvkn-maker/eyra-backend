/**
 * Live stream socket event handlers.
 * Handles join_room, leave_room, chat_message, pin/unpin, mute/unmute.
 */

const LiveStream = require('../models/LiveStream');
const Message = require('../models/Message');
const User = require('../models/User');

/**
 * Register live stream events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance
 */
function register(socket, io) {
  // İzleyici yayın odasına katılıyor
  socket.on('live:join_room', async ({ roomId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) {
      console.log(`⚠️ live:join_room - missing roomId or userId`);
      return;
    }

    try {
      socket.join(roomId);
      console.log(`📺 User ${userId} joined live room: ${roomId}`);

      const updatedStream = await LiveStream.findOneAndUpdate(
        { roomId, isLive: true, status: 'live' },
        {
          $inc: { viewerCount: 1 },
          $addToSet: { viewers: userId },
        },
        { new: true },
      ).select('viewerCount peakViewerCount');

      if (updatedStream) {
        if (updatedStream.viewerCount > updatedStream.peakViewerCount) {
          await LiveStream.updateOne(
            { _id: updatedStream._id },
            { $max: { peakViewerCount: updatedStream.viewerCount } },
          );
        }

        socket.to(roomId).emit('viewer_joined', {
          roomId,
          userId,
          viewerCount: updatedStream.viewerCount,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.error('❌ live:join_room error:', e.message);
      socket.emit('error', { message: 'join_room_failed' });
    }
  });

  // İzleyici yayın odasından ayrılıyor
  socket.on('live:leave_room', async ({ roomId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) {
      console.log(`⚠️ live:leave_room - missing roomId or userId`);
      return;
    }

    try {
      socket.leave(roomId);
      console.log(`📺 User ${userId} left live room: ${roomId}`);

      const updatedStream = await LiveStream.findOneAndUpdate(
        { roomId },
        {
          $inc: { viewerCount: -1 },
          $pull: { viewers: userId },
        },
        { new: true },
      ).select('viewerCount');

      if (updatedStream) {
        let finalCount = updatedStream.viewerCount;
        if (finalCount < 0) {
          await LiveStream.updateOne(
            { _id: updatedStream._id },
            { $set: { viewerCount: 0 } },
          );
          finalCount = 0;
        }

        socket.to(roomId).emit('viewer_left', {
          roomId,
          userId,
          viewerCount: finalCount,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.error('❌ live:leave_room error:', e.message);
      socket.emit('error', { message: 'leave_room_failed' });
    }
  });

  // Yayın içi chat mesajı (real-time)
  socket.on('live:chat_message', async ({ roomId, message, type = 'text' }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId || !message) {
      console.log(`⚠️ live:chat_message - missing required fields`);
      return;
    }

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) {
        socket.emit('error', { message: 'stream_not_found' });
        return;
      }

      if (message.length > 500) {
        socket.emit('error', { message: 'message_too_long' });
        return;
      }

      const user = await User.findById(userId).select('username name profileImage').lean();
      if (!user) {
        socket.emit('error', { message: 'user_not_found' });
        return;
      }

      const msg = await Message.create({
        roomId,
        from: userId,
        type,
        content: message,
      });

      io.to(roomId).emit('chat_message', {
        _id: msg._id,
        roomId,
        type,
        content: message,
        sender: {
          _id: userId,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
        },
        timestamp: msg.createdAt,
      });
    } catch (e) {
      console.error('❌ live:chat_message error:', e.message);
      socket.emit('error', { message: 'chat_send_failed' });
    }
  });

  // Pinned message
  socket.on('live:pin_message', async ({ roomId, messageId, content }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) return;

      if (stream.hostId.toString() !== userId) {
        socket.emit('error', { message: 'only_host_can_pin' });
        return;
      }

      io.to(roomId).emit('message_pinned', {
        roomId,
        messageId,
        content,
        pinnedAt: new Date(),
      });

      console.log(`📌 Message pinned in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:pin_message error:', e.message);
    }
  });

  // Unpin message
  socket.on('live:unpin_message', async ({ roomId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId) return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream || stream.hostId.toString() !== userId) return;

      io.to(roomId).emit('message_unpinned', { roomId });
      console.log(`📌 Message unpinned in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:unpin_message error:', e.message);
    }
  });

  // Mute user
  socket.on('live:mute_user', async ({ roomId, targetUserId, duration = 300 }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId || !targetUserId) return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) return;

      if (stream.hostId.toString() !== userId) {
        socket.emit('error', { message: 'only_host_can_mute' });
        return;
      }

      io.to(roomId).emit('user_muted', {
        roomId,
        mutedUserId: targetUserId,
        mutedUntil: new Date(Date.now() + duration * 1000),
        duration,
      });

      console.log(`🔇 User ${targetUserId} muted for ${duration}s in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:mute_user error:', e.message);
    }
  });

  // Unmute user
  socket.on('live:unmute_user', async ({ roomId, targetUserId }) => {
    const userId = socket.data.userId;
    if (!roomId || !userId || !targetUserId) return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream || stream.hostId.toString() !== userId) return;

      io.to(roomId).emit('user_unmuted', {
        roomId,
        unmutedUserId: targetUserId,
      });

      console.log(`🔊 User ${targetUserId} unmuted in room ${roomId}`);
    } catch (e) {
      console.error('❌ live:unmute_user error:', e.message);
    }
  });
}

module.exports = { register };
