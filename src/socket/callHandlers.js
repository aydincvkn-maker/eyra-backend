/**
 * Call signaling socket event handlers.
 * Handles call:accept, call:reject, call:end, call:cancel, call:coin_tick.
 */

const { activeCalls } = require("./state");
const { emitToUserSockets, getCounterpartyForRoom } = require("./helpers");
const presenceService = require("../services/presenceService");
const User = require("../models/User");
const { sanitizeSocketPayload } = require("../middleware/validate");
const { logger } = require("../utils/logger");

/**
 * Register call signaling events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance (unused directly but kept for consistency)
 */
function register(socket, io) {
  const forwardCallEvent = async (eventName, roomName) => {
    const senderId = socket.data.userId;
    if (!senderId) {
      logger.debug(`${eventName} received but senderId missing`);
      return;
    }
    if (!roomName || typeof roomName !== 'string') {
      logger.debug(`${eventName} received but roomName missing`);
      return;
    }

    const counterpartyId = getCounterpartyForRoom(roomName, senderId);
    if (!counterpartyId) {
      logger.debug(`${eventName} - no counterparty found`, { roomName });
      return;
    }

    logger.debug(`Forwarding ${eventName}`, { from: senderId, to: counterpartyId, roomName });
    emitToUserSockets(counterpartyId, eventName, {
      roomName,
      fromUserId: String(senderId),
    });

    // Cleanup on call end/reject
    if (eventName === "call:ended" || eventName === "call:rejected") {
      const callInfo = activeCalls.get(roomName);
      if (callInfo) {
        try {
          await presenceService
            .setBusy(callInfo.callerId, false)
            .catch((e) =>
              logger.error(`setBusy cleanup for ${callInfo.callerId} failed`, { err: String(e) }),
            );
          await presenceService
            .setBusy(callInfo.targetUserId, false)
            .catch((e) =>
              logger.error(`setBusy cleanup for ${callInfo.targetUserId} failed`, { err: String(e) }),
            );
          logger.debug(`Both users set as not busy for room: ${roomName}`);
        } catch (e) {
          logger.error('setBusy cleanup error', { err: String(e) });
        }
      }

      activeCalls.delete(roomName);
      logger.debug(`Cleaned up call: ${roomName}`);

      // Yayın odasına host'un döndüğünü bildir (pembe overlay kapatılsın)
      if (eventName === "call:ended" && global.callRequests && global.io) {
        for (const [reqId, req] of global.callRequests) {
          if (req.callRoomName === roomName && req.roomId) {
            global.io.to(req.roomId).emit("host_returned_from_call", {
              hostId: req.hostId,
              hostName: req.hostName || "Yayıncı",
              callerName: req.callerName || "Kullanıcı",
            });
            logger.debug(`host_returned_from_call emitted to room ${req.roomId}`);
            global.callRequests.delete(reqId);
            break;
          }
        }
      }
    }
  };

  socket.on("call:accept", (rawData) => {
    const { roomName } = sanitizeSocketPayload(rawData);
    forwardCallEvent("call:accepted", roomName);
  });
  socket.on("call:reject", (rawData) => {
    const { roomName } = sanitizeSocketPayload(rawData);
    forwardCallEvent("call:rejected", roomName);
  });
  socket.on("call:end", (rawData) => {
    const { roomName } = sanitizeSocketPayload(rawData);
    forwardCallEvent("call:ended", roomName);
  });
  socket.on("call:cancel", (rawData) => {
    const { roomName } = sanitizeSocketPayload(rawData);
    forwardCallEvent("call:cancelled", roomName);
  });

  // Paid call coin tick (dakikalık ücretlendirme)
  // ✅ FIX: Server-side timer ile destekle — client tick gelirse kabul et,
  // gelmezse server kendi timer'ı ile ücretlendir
  socket.on("call:coin_tick", async (rawData) => {
    const { roomName, requestId, minuteIndex } = sanitizeSocketPayload(rawData);
    const senderId = socket.data.userId;
    if (!senderId || !roomName || typeof roomName !== 'string') return;

    try {
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
        logger.debug('call:coin_tick - call info not found', { roomName });
        return;
      }

      // Sadece caller'dan gelen tick'leri işle
      if (String(senderId) !== String(callInfo.callerId)) {
        return;
      }

      // ✅ FIX: Server-side timer varsa resetle (client aktif)
      if (callInfo._serverTickTimer) {
        clearInterval(callInfo._serverTickTimer);
        callInfo._serverTickTimer = null;
      }

      _processCallTick(callInfo, minuteIndex);
    } catch (e) {
      logger.error('call:coin_tick error', { err: e.message });
    }
  });
}

/**
 * ✅ Server-side tick timer başlat — eğer client tick göndermezse server ücretlendirir
 */
function startServerSideTickTimer(callRoomName) {
  if (!global.callRequests) return;

  let callInfo = null;
  for (const [, req] of global.callRequests) {
    if (req.callRoomName === callRoomName) {
      callInfo = req;
      break;
    }
  }
  if (!callInfo) return;

  let serverMinute = 0;
  callInfo._serverTickTimer = setInterval(() => {
    // Call hala aktif mi?
    let stillActive = false;
    if (global.callRequests) {
      for (const [, req] of global.callRequests) {
        if (req.callRoomName === callRoomName) {
          stillActive = true;
          break;
        }
      }
    }
    if (!stillActive) {
      clearInterval(callInfo._serverTickTimer);
      return;
    }

    serverMinute++;
    _processCallTick(callInfo, serverMinute);
  }, 60 * 1000); // Her 60 saniyede bir
}

/**
 * Ortak coin tick işleme mantığı
 */
async function _processCallTick(callInfo, minuteIndex) {
  try {
    if (!callInfo._lastTickMinute) callInfo._lastTickMinute = -1;
    if (minuteIndex <= callInfo._lastTickMinute) return;
    callInfo._lastTickMinute = minuteIndex;

    const pricePerMinute = callInfo.pricePerMinute || 120;

    const updatedCaller = await User.findOneAndUpdate(
      { _id: callInfo.callerId, coins: { $gte: pricePerMinute } },
      { $inc: { coins: -pricePerMinute } },
      { new: true, select: "coins" },
    );
    if (!updatedCaller) {
      emitToUserSockets(callInfo.callerId, "call:insufficient_coins", {
        roomName: callInfo.callRoomName,
      });
      emitToUserSockets(callInfo.hostId, "call:insufficient_coins", {
        roomName: callInfo.callRoomName,
      });
      logger.info('Insufficient coins for call, ending', { roomName: callInfo.callRoomName });
      // Stop server timer
      if (callInfo._serverTickTimer) clearInterval(callInfo._serverTickTimer);
      return;
    }

    const hostShare = Math.floor(pricePerMinute * 0.7);
    await User.findByIdAndUpdate(callInfo.hostId, {
      $inc: { coins: hostShare, totalEarnings: hostShare },
    });

    emitToUserSockets(callInfo.callerId, "call:coin_charged", {
      roomName: callInfo.callRoomName,
      amount: pricePerMinute,
      remaining: updatedCaller.coins,
      minute: minuteIndex + 1,
    });
    emitToUserSockets(callInfo.hostId, "call:coin_charged", {
      roomName: callInfo.callRoomName,
      amount: hostShare,
      earned: true,
      minute: minuteIndex + 1,
    });

    logger.debug('Call tick processed', { caller: callInfo.callerId, amount: pricePerMinute, minute: minuteIndex + 1, hostShare });
  } catch (e) {
    logger.error('_processCallTick error', { err: e.message });
  }
}

module.exports = { register, startServerSideTickTimer };
