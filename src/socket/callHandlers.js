/**
 * Call signaling socket event handlers.
 * Handles call:accept, call:reject, call:end, call:cancel, call:coin_tick.
 */

const { activeCalls } = require('./state');
const { emitToUserSockets, getCounterpartyForRoom } = require('./helpers');
const presenceService = require('../services/presenceService');
const User = require('../models/User');

/**
 * Register call signaling events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance (unused directly but kept for consistency)
 */
function register(socket, io) {
  const forwardCallEvent = async (eventName, roomName) => {
    const senderId = socket.data.userId;
    if (!senderId) {
      console.log(`⚠️ ${eventName} received but senderId missing`);
      return;
    }
    if (!roomName) {
      console.log(`⚠️ ${eventName} received but roomName missing`);
      return;
    }

    const counterpartyId = getCounterpartyForRoom(roomName, senderId);
    if (!counterpartyId) {
      console.log(`⚠️ ${eventName} - no counterparty found for room ${roomName}`);
      return;
    }

    console.log(`📞 Forwarding ${eventName} from ${senderId} to ${counterpartyId} for room ${roomName}`);
    emitToUserSockets(counterpartyId, eventName, {
      roomName,
      fromUserId: String(senderId),
    });

    // Cleanup on call end/reject
    if (eventName === 'call:ended' || eventName === 'call:rejected') {
      const callInfo = activeCalls.get(roomName);
      if (callInfo) {
        try {
          await presenceService.setBusy(callInfo.callerId, false).catch((e) =>
            console.error(`⚠️ setBusy cleanup for ${callInfo.callerId} failed: ${e}`),
          );
          await presenceService.setBusy(callInfo.targetUserId, false).catch((e) =>
            console.error(`⚠️ setBusy cleanup for ${callInfo.targetUserId} failed: ${e}`),
          );
          console.log(`✅ Both users set as not busy for room: ${roomName}`);
        } catch (e) {
          console.error(`⚠️ setBusy cleanup error: ${e}`);
        }
      }

      activeCalls.delete(roomName);
      console.log(`🧹 Cleaned up call: ${roomName}`);
    }
  };

  socket.on('call:accept', ({ roomName }) => forwardCallEvent('call:accepted', roomName));
  socket.on('call:reject', ({ roomName }) => forwardCallEvent('call:rejected', roomName));
  socket.on('call:end', ({ roomName }) => forwardCallEvent('call:ended', roomName));
  socket.on('call:cancel', ({ roomName }) => forwardCallEvent('call:cancelled', roomName));

  // Paid call coin tick (dakikalık ücretlendirme)
  socket.on('call:coin_tick', async ({ roomName, requestId, minuteIndex }) => {
    const senderId = socket.data.userId;
    if (!senderId || !roomName) return;

    try {
      // callRequests veya activeCalls'dan bilgiyi bul
      let callInfo = null;
      if (global.callRequests) {
        for (const [, req] of global.callRequests) {
          if (req.callRoomName === roomName) {
            callInfo = req;
            break;
          }
        }
      }

      if (!callInfo) {
        console.log(`⚠️ call:coin_tick - call info not found for room ${roomName}`);
        return;
      }

      // Sadece caller'dan gelen tick'leri işle (çift tick önleme)
      if (String(senderId) !== String(callInfo.callerId)) {
        return;
      }

      // Duplicate tick önleme (aynı minuteIndex için)
      if (!callInfo._lastTickMinute) callInfo._lastTickMinute = -1;
      if (minuteIndex <= callInfo._lastTickMinute) {
        return;
      }
      callInfo._lastTickMinute = minuteIndex;

      const pricePerMinute = callInfo.pricePerMinute || 120;

      // Caller'dan coin düş
      const caller = await User.findById(callInfo.callerId);
      if (!caller || caller.coins < pricePerMinute) {
        emitToUserSockets(callInfo.callerId, 'call:insufficient_coins', { roomName });
        emitToUserSockets(callInfo.hostId, 'call:insufficient_coins', { roomName });
        console.log(`💰 Insufficient coins for call ${roomName}, ending call`);
        return;
      }

      caller.coins -= pricePerMinute;
      await caller.save();

      // Host'a coin ekle (%70)
      const hostShare = Math.floor(pricePerMinute * 0.7);
      await User.findByIdAndUpdate(callInfo.hostId, {
        $inc: { coins: hostShare, totalEarnings: hostShare },
      });

      // Her iki tarafa bildir
      emitToUserSockets(callInfo.callerId, 'call:coin_charged', {
        roomName,
        amount: pricePerMinute,
        remaining: caller.coins,
        minute: minuteIndex + 1,
      });
      emitToUserSockets(callInfo.hostId, 'call:coin_charged', {
        roomName,
        amount: hostShare,
        earned: true,
        minute: minuteIndex + 1,
      });

      console.log(`💰 Call tick: ${callInfo.callerId} charged ${pricePerMinute} coins (minute ${minuteIndex + 1}), host earned ${hostShare}`);
    } catch (e) {
      console.error('❌ call:coin_tick error:', e.message);
    }
  });
}

module.exports = { register };
