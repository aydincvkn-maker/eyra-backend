/**
 * Call signaling socket event handlers.
 * Handles call:accept, call:reject, call:end, call:cancel, call:coin_tick.
 */

const { activeCalls } = require("./state");
const { emitToUserSockets, getCounterpartyForRoom } = require("./helpers");
const presenceService = require("../services/presenceService");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const CallHistory = require("../models/CallHistory");
const { sanitizeSocketPayload } = require("../middleware/validate");
const { logger } = require("../utils/logger");

/**
 * Register call signaling events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance (unused directly but kept for consistency)
 */
function register(socket, io) {
  const findPaidCallByRoomName = (roomName) => {
    if (!global.callRequests || !roomName) return null;

    for (const [, request] of global.callRequests) {
      if (request.callRoomName === roomName) {
        return request;
      }
    }

    return null;
  };

  const clearCallAnswerTimeout = (roomName) => {
    if (!global.callTimeouts || !roomName) return;
    const timer = global.callTimeouts.get(roomName);
    if (timer) {
      clearTimeout(timer);
      global.callTimeouts.delete(roomName);
    }
  };

  const forwardCallEvent = async (eventName, roomName) => {
    const senderId = socket.data.userId;
    if (!senderId) {
      logger.debug(`${eventName} received but senderId missing`);
      return;
    }
    if (!roomName || typeof roomName !== "string") {
      logger.debug(`${eventName} received but roomName missing`);
      return;
    }

    const counterpartyId = getCounterpartyForRoom(roomName, senderId);
    if (!counterpartyId) {
      logger.debug(`${eventName} - no counterparty found`, { roomName });
      return;
    }

    logger.debug(`Forwarding ${eventName}`, {
      from: senderId,
      to: counterpartyId,
      roomName,
    });
    emitToUserSockets(counterpartyId, eventName, {
      roomName,
      fromUserId: String(senderId),
    });

    if (eventName === "call:accepted") {
      // Cevap timeout'unu iptal et — arama kabul edildi
      if (global.callTimeouts) {
        const timer = global.callTimeouts.get(roomName);
        if (timer) {
          clearTimeout(timer);
          global.callTimeouts.delete(roomName);
        }
      }
      startServerSideTickTimer(roomName);
      const paidCall = findPaidCallByRoomName(roomName);
      if (paidCall) {
        paidCall.status = "connected";
      }
    }

    // Cleanup on call end/reject
    if (
      eventName === "call:ended" ||
      eventName === "call:rejected" ||
      eventName === "call:cancelled"
    ) {
      const callInfo = activeCalls.get(roomName);
      clearCallAnswerTimeout(roomName);
      clearServerSideTickTimer(roomName);
      if (callInfo) {
        try {
          await presenceService.setBusy(callInfo.callerId, false).catch((e) =>
            logger.error(`setBusy cleanup for ${callInfo.callerId} failed`, {
              err: String(e),
            }),
          );
          await presenceService
            .setBusy(callInfo.targetUserId, false)
            .catch((e) =>
              logger.error(
                `setBusy cleanup for ${callInfo.targetUserId} failed`,
                { err: String(e) },
              ),
            );
          logger.debug(`Both users set as not busy for room: ${roomName}`);
        } catch (e) {
          logger.error("setBusy cleanup error", { err: String(e) });
        }

        try {
          const update = { endedAt: new Date() };
          if (eventName === "call:ended") {
            const startTime = callInfo.createdAt || Date.now();
            update.status = "completed";
            update.durationSec = Math.max(
              0,
              Math.floor((Date.now() - startTime) / 1000),
            );
          } else if (eventName === "call:rejected") {
            update.status = "rejected";
          } else if (eventName === "call:cancelled") {
            update.status = "cancelled";
          }
          await CallHistory.findOneAndUpdate(
            { roomName },
            { $set: update },
          ).catch(() => {});
        } catch (e) {
          logger.error("CallHistory socket cleanup error", { err: String(e) });
        }
      }

      activeCalls.delete(roomName);
      logger.debug(`Cleaned up call: ${roomName}`);

      // Yayın odasına host'un döndüğünü bildir (pembe overlay kapatılsın)
      if (eventName === "call:ended" && global.callRequests && global.io) {
        for (const [reqId, req] of global.callRequests) {
          if (req.callRoomName === roomName) {
            if (req.roomId) {
              // Live yayın araması — yayın odasına bildir
              global.io.to(req.roomId).emit("host_returned_from_call", {
                hostId: req.hostId,
                hostName: req.hostName || "Yayıncı",
                callerName: req.callerName || "Kullanıcı",
              });
              logger.debug(
                `host_returned_from_call emitted to room ${req.roomId}`,
              );
            }
            // Her iki tip araması için callRequests'ten temizle
            global.callRequests.delete(reqId);
            break;
          }
        }
      }

      // Reddedilen/iptal edilen direkt aramalar için callRequests temizliği
      if (
        (eventName === "call:rejected" || eventName === "call:cancelled") &&
        global.callRequests
      ) {
        for (const [reqId, req] of global.callRequests) {
          if (req.callRoomName === roomName && req.isDirectCall) {
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
    if (!senderId || !roomName || typeof roomName !== "string") return;

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
        logger.debug("call:coin_tick - call info not found", { roomName });
        return;
      }

      // Sadece caller'dan gelen tick'leri işle
      if (String(senderId) !== String(callInfo.callerId)) {
        return;
      }

      // ✅ Direkt (kullanıcı→kullanıcı) aramalarda ücretlendirme tamamen
      // server-side timer ile yapılır. Client tick'leri yok say — aksi halde
      // değiştirilmiş bir istemci tick göndermeyi durdurarak ücretsiz
      // konuşabilirdi.
      if (callInfo.isDirectCall) {
        return;
      }

      // ✅ FIX: Server-side timer varsa resetle (client aktif)
      if (callInfo._serverTickTimer) {
        clearInterval(callInfo._serverTickTimer);
        callInfo._serverTickTimer = null;
      }

      _processCallTick(callInfo, minuteIndex);
    } catch (e) {
      logger.error("call:coin_tick error", { err: e.message });
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

  if (callInfo._serverTickTimer) {
    return;
  }

  // ✅ İlk dakika ücretini kabul anında peşin al — 60 saniyeden kısa aramalar
  // da ücretli olsun (kimse ücretsiz aramasın). Coin arayandan düşer, %70'i
  // aranana (host) geçer.
  _processCallTick(callInfo, 1);

  let serverMinute = 1; // İlk dakika alındı; timer 2. dakikadan devam etsin
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
      callInfo._serverTickTimer = null;
      return;
    }

    serverMinute++;
    _processCallTick(callInfo, serverMinute);
  }, 60 * 1000); // Her 60 saniyede bir
  callInfo._serverTickTimer.unref?.();
}

function clearServerSideTickTimer(callRoomName) {
  if (!global.callRequests || !callRoomName) return;

  for (const [, request] of global.callRequests) {
    if (request.callRoomName === callRoomName && request._serverTickTimer) {
      clearInterval(request._serverTickTimer);
      request._serverTickTimer = null;
      return;
    }
  }
}

/**
 * Ortak coin tick işleme mantığı
 */
async function _processCallTick(callInfo, minuteIndex) {
  try {
    if (!callInfo._lastTickMinute) callInfo._lastTickMinute = -1;
    if (minuteIndex <= callInfo._lastTickMinute) return;
    callInfo._lastTickMinute = minuteIndex;

    const pricePerMinute = Number(callInfo.pricePerMinute || 0);
    const freeMinutes = callInfo.freeMinutes || 0;
    const payerId = callInfo.payerId || callInfo.callerId;
    const earnerId = callInfo.earnerId || callInfo.hostId;

    if (pricePerMinute <= 0 || !payerId || !earnerId) {
      return;
    }

    // Ücretsiz dakika içindeyse coin düşme
    if (minuteIndex <= freeMinutes) {
      logger.debug(
        `Call tick minute ${minuteIndex} is free (freeMinutes=${freeMinutes})`,
      );
      return;
    }

    const updatedCaller = await User.findOneAndUpdate(
      { _id: payerId, coins: { $gte: pricePerMinute } },
      { $inc: { coins: -pricePerMinute } },
      { new: true, select: "coins" },
    );
    if (!updatedCaller) {
      emitToUserSockets(payerId, "call:insufficient_coins", {
        roomName: callInfo.callRoomName,
      });
      emitToUserSockets(earnerId, "call:insufficient_coins", {
        roomName: callInfo.callRoomName,
      });
      logger.info("Insufficient coins for call, ending", {
        roomName: callInfo.callRoomName,
      });
      // Stop server timer
      if (callInfo._serverTickTimer) {
        clearInterval(callInfo._serverTickTimer);
        callInfo._serverTickTimer = null;
      }
      return;
    }

    const hostShare = Math.floor(pricePerMinute * 0.7);
    const updatedHost = await User.findByIdAndUpdate(
      earnerId,
      { $inc: { coins: hostShare, totalEarnings: hostShare } },
      { new: true },
    );

    // ✅ Arama kazancını Transaction olarak kaydet — günlük canlı kazanç
    //    sayacı ve haftalık performans/maaş hesabı bu kayıtları kullanır.
    //    Fire-and-forget: kayıt hatası ücretlendirmeyi bozmaz.
    Transaction.create({
      user: earnerId,
      type: "call_earning",
      amount: hostShare,
      balanceAfter: updatedHost ? updatedHost.coins : undefined,
      relatedUser: payerId,
      description: "Görüntülü arama kazancı",
    }).catch((e) => logger.error("call_earning transaction error:", e.message));

    emitToUserSockets(payerId, "call:coin_charged", {
      roomName: callInfo.callRoomName,
      amount: pricePerMinute,
      remaining: updatedCaller.coins,
      minute: minuteIndex + 1,
    });
    emitToUserSockets(earnerId, "call:coin_charged", {
      roomName: callInfo.callRoomName,
      amount: hostShare,
      earned: true,
      minute: minuteIndex + 1,
    });

    logger.debug("Call tick processed", {
      payer: payerId,
      earner: earnerId,
      amount: pricePerMinute,
      minute: minuteIndex + 1,
      hostShare,
    });
  } catch (e) {
    logger.error("_processCallTick error", { err: e.message });
  }
}

module.exports = { register, startServerSideTickTimer };
