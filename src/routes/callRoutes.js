// src/routes/callRoutes.js
// Video call signaling endpoints

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const presenceService = require("../services/presenceService");
const { LIVEKIT_URL } = require("../config/env");
const { generateLiveKitToken } = require("../services/liveService");
const CallHistory = require("../models/CallHistory");
const User = require("../models/User");
const { sendError } = require("../utils/response");
const { createNotification } = require("../controllers/notificationController");
const { logger } = require("../utils/logger");

// Cevaplanmayan aramalar için timeout (60 saniye)
const CALL_ANSWER_TIMEOUT_MS = 60000;
const callTimeouts = new Map();

function getActiveSocketForUser(userId) {
  const targetKey = String(userId || "").trim();
  if (!targetKey || !global.userSockets || !global.io) return null;

  const socketIds = global.userSockets.get(targetKey);
  if (!socketIds || socketIds.size === 0) return null;

  for (const socketId of socketIds) {
    const socket = global.io.sockets?.sockets?.get(socketId);
    if (socket?.connected) {
      return socket;
    }
  }

  return null;
}

/**
 * Belirli bir arama için timeout'u temizle
 */
function clearCallTimeout(roomName) {
  const timer = callTimeouts.get(roomName);
  if (timer) {
    clearTimeout(timer);
    callTimeouts.delete(roomName);
  }
}

/**
 * Cevaplanmayan arama timeout handler
 * Hem arayan hem aranan kullanıcının busy durumunu temizler
 */
async function handleCallTimeout(roomName) {
  callTimeouts.delete(roomName);
  const callInfo = global.activeCalls?.get(roomName);
  if (!callInfo) return;

  const { callerId, targetUserId } = callInfo;
  logger.info(
    `⏰ Call timeout (${CALL_ANSWER_TIMEOUT_MS / 1000}s): ${roomName}`,
  );

  try {
    // Her iki kullanıcının busy durumunu temizle
    await Promise.all([
      presenceService.setBusy(callerId, false),
      presenceService.setBusy(targetUserId, false),
    ]);

    // CallHistory'yi missed olarak güncelle
    await CallHistory.findOneAndUpdate(
      { roomName },
      { $set: { status: "missed", endedAt: new Date() } },
    ).catch(() => {});

    // Active call'dan kaldır
    global.activeCalls?.delete(roomName);

    // Socket ile her iki tarafa bildir
    if (global.io && global.userSockets) {
      [callerId, targetUserId].forEach((uid) => {
        const sockets = global.userSockets.get(String(uid));
        if (sockets && sockets.size > 0) {
          sockets.forEach((socketId) => {
            global.io.to(socketId).emit("call:timeout", {
              roomName,
              message: "Arama zaman aşımına uğradı",
              timestamp: Date.now(),
            });
          });
        }
      });
    }

    // Arayana cevapsız arama bildirimi
    try {
      const target = await User.findById(targetUserId)
        .select("name username")
        .lean();
      const targetName = target?.name || target?.username || "Birisi";
      await createNotification({
        recipientId: callerId,
        type: "call_missed",
        title: "Cevapsız Arama",
        titleEn: "Missed Call",
        body: `${targetName} aramanızı yanıtlayamadı`,
        bodyEn: `${targetName} couldn't answer your call`,
        senderId: targetUserId,
        relatedId: roomName,
        relatedType: "call",
      });
    } catch (_) {}
  } catch (err) {
    logger.error("❌ Call timeout handler error:", err);
  }
}

/**
 * POST /api/calls/initiate
 * Start a call to another user
 */
router.post("/initiate", auth, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const callerId = req.user.id;

    if (!targetUserId) {
      return sendError(res, 400, "targetUserId gerekli");
    }

    if (callerId === targetUserId) {
      return sendError(res, 400, "Kendinizi arayamazsınız");
    }

    // Check if target user is available (socket-driven, in-memory)
    let targetPresence = await presenceService.getPresence(targetUserId);
    if (!targetPresence.online) {
      const activeSocket = getActiveSocketForUser(targetUserId);
      if (activeSocket) {
        targetPresence = await presenceService.setOnline(targetUserId, {
          socketId: activeSocket.id,
          gender: activeSocket.data?.gender,
        });
      }
    }

    if (!targetPresence.online) {
      return res.status(400).json({
        message: "Kullanıcı çevrimdışı",
        presenceStatus: "offline",
      });
    }

    if (targetPresence.busy || targetPresence.inCall) {
      return res.status(400).json({
        message: "Kullanıcı meşgul",
        presenceStatus: "in_call",
      });
    }

    if (targetPresence.live) {
      return res.status(400).json({
        message: "Kullanıcı canlı yayında",
        presenceStatus: "live",
      });
    }

    // Create room
    const roomName = `call_${callerId}_${targetUserId}_${Date.now()}`;

    // Set both users as busy
    await Promise.all([
      presenceService.setBusy(callerId, true, {
        partnerId: targetUserId,
        roomName,
      }),
      presenceService.setBusy(targetUserId, true, {
        partnerId: callerId,
        roomName,
      }),
    ]);

    // Store call info in global state
    if (global.activeCalls) {
      global.activeCalls.set(roomName, {
        callerId,
        targetUserId,
        roomName,
        createdAt: Date.now(),
      });
    }

    // Cevaplanmayan arama timeout'u başlat
    const timer = setTimeout(
      () => handleCallTimeout(roomName),
      CALL_ANSWER_TIMEOUT_MS,
    );
    callTimeouts.set(roomName, timer);

    // Save call history record
    try {
      await CallHistory.create({
        caller: callerId,
        receiver: targetUserId,
        type: "video",
        status: "missed", // Will be updated on accept/end
        roomName,
        startedAt: new Date(),
      });
    } catch (histErr) {
      logger.error("❌ CallHistory create error:", histErr);
    }

    // Notify target user via socket
    if (global.io && global.userSockets) {
      const targetKey = String(targetUserId);
      logger.info(`📞 Looking for target user: ${targetKey}`);
      logger.info(
        `📞 Active user sockets: ${Array.from(global.userSockets.keys()).join(", ")}`,
      );

      const targetSockets = global.userSockets.get(targetKey);
      if (targetSockets && targetSockets.size > 0) {
        logger.info(
          `✅ Found ${targetSockets.size} socket(s) for ${targetKey}`,
        );
        const callerData = await require("../models/User")
          .findById(callerId)
          .select("username profileImage");

        targetSockets.forEach((socketId) => {
          logger.info(`📡 Sending incoming_call to socket ${socketId}`);
          global.io.to(socketId).emit("incoming_call", {
            callerId: String(callerId),
            callerName: callerData?.username || "Unknown",
            callerImage: callerData?.profileImage || "",
            roomName,
            timestamp: Date.now(),
          });
        });
      } else {
        logger.info(`❌ No sockets found for target user ${targetKey}`);
      }
    }

    res.json({
      success: true,
      roomName,
      callerId: String(callerId),
      targetUserId: String(targetUserId),
      message: "Arama başlatıldı",
    });
  } catch (error) {
    logger.error("❌ Call initiate error:", error);
    sendError(res, 500, "Sunucu hatası");
  }
});

/**
 * POST /api/calls/end
 * End an active call
 */
router.post("/end", auth, async (req, res) => {
  try {
    const { roomName } = req.body;
    const userId = req.user.id;

    if (!roomName) {
      return sendError(res, 400, "roomName gerekli");
    }

    // Timeout'u temizle
    clearCallTimeout(roomName);

    // Get call info
    const callInfo = global.activeCalls?.get(roomName);

    if (callInfo) {
      const { callerId, targetUserId } = callInfo;

      // Set both users as no longer busy
      await Promise.all([
        presenceService.setBusy(callerId, false),
        presenceService.setBusy(targetUserId, false),
      ]);

      // Update call history - mark as completed with duration
      try {
        const startTime = callInfo.createdAt || Date.now();
        const durationSec = Math.floor((Date.now() - startTime) / 1000);
        await CallHistory.findOneAndUpdate(
          { roomName },
          { $set: { status: "completed", durationSec, endedAt: new Date() } },
        );
      } catch (histErr) {
        logger.error("❌ CallHistory update error:", histErr);
      }

      // Remove from active calls
      global.activeCalls.delete(roomName);

      // Notify via socket
      if (global.io) {
        global.io.emit("call:ended", {
          roomName,
          endedBy: String(userId),
          timestamp: Date.now(),
        });
      }
    }

    res.json({
      success: true,
      message: "Arama sonlandırıldı",
    });
  } catch (error) {
    logger.error("❌ Call end error:", error);
    sendError(res, 500, "Sunucu hatası");
  }
});

/**
 * POST /api/calls/reject
 * Reject an incoming call
 */
router.post("/reject", auth, async (req, res) => {
  try {
    const { roomName } = req.body;
    const userId = req.user.id;

    if (!roomName) {
      return sendError(res, 400, "roomName gerekli");
    }

    // Timeout'u temizle
    clearCallTimeout(roomName);

    // Get call info
    const callInfo = global.activeCalls?.get(roomName);

    if (callInfo) {
      const { callerId, targetUserId } = callInfo;

      // Set both users as no longer busy
      await Promise.all([
        presenceService.setBusy(callerId, false),
        presenceService.setBusy(targetUserId, false),
      ]);

      // Update call history - mark as rejected
      try {
        await CallHistory.findOneAndUpdate(
          { roomName },
          { $set: { status: "rejected", endedAt: new Date() } },
        );
      } catch (histErr) {
        logger.error("❌ CallHistory reject update error:", histErr);
      }

      // Remove from active calls
      global.activeCalls.delete(roomName);

      // Notify caller via socket that call was rejected
      if (global.io && global.userSockets) {
        const callerKey = String(callerId);
        const callerSockets = global.userSockets.get(callerKey);
        if (callerSockets && callerSockets.size > 0) {
          callerSockets.forEach((socketId) => {
            global.io.to(socketId).emit("call:rejected", {
              roomName,
              rejectedBy: String(userId),
              timestamp: Date.now(),
            });
          });
        }
      }

      // 🔔 Arayanı bilgilendir: "X sizi aradı" push bildirimi
      try {
        const rejecter = await User.findById(userId)
          .select("name username")
          .lean();
        const rejecterName = rejecter?.name || rejecter?.username || "Birisi";
        await createNotification({
          recipientId: callerId,
          type: "call_missed",
          title: "Cevapsız Arama",
          titleEn: "Missed Call",
          body: `${rejecterName} aramanızı yanıtlayamadı`,
          bodyEn: `${rejecterName} couldn't answer your call`,
          senderId: userId,
          relatedId: roomName,
          relatedType: "call",
        });
      } catch (notifErr) {
        logger.error("❌ Cevapsız arama bildirimi hatası:", notifErr.message);
      }
    }

    res.json({
      success: true,
      message: "Arama reddedildi",
    });
  } catch (error) {
    logger.error("❌ Call reject error:", error);
    sendError(res, 500, "Sunucu hatası");
  }
});

/**
 * POST /api/calls/token
 * Generate LiveKit token for a call room
 */
router.post("/token", auth, async (req, res) => {
  try {
    const { roomName, userName } = req.body;
    const userId = String(req.user.id);

    if (!roomName) {
      return res.status(400).json({ ok: false, message: "roomName gerekli" });
    }

    const displayName = (userName || req.user.username || "User").toString();
    const token = await generateLiveKitToken(roomName, displayName, userId);

    if (!token || typeof token !== "string") {
      return res.status(500).json({ ok: false, message: "Token üretilemedi" });
    }

    return res.json({
      ok: true,
      token,
      roomName,
      livekitUrl: LIVEKIT_URL,
    });
  } catch (error) {
    logger.error("❌ Call token error:", error);
    return res.status(500).json({ ok: false, message: "Sunucu hatası" });
  }
});

/**
 * GET /api/calls/active
 * Get active calls for debugging
 */
router.get("/active", auth, async (req, res) => {
  try {
    const activeCalls = global.activeCalls
      ? Array.from(global.activeCalls.entries()).map(([roomName, info]) => ({
          roomName,
          ...info,
        }))
      : [];

    res.json({
      count: activeCalls.length,
      calls: activeCalls,
    });
  } catch (error) {
    logger.error("❌ Get active calls error:", error);
    sendError(res, 500, "Sunucu hatası");
  }
});

/**
 * GET /api/calls/history
 * Get call history for the current user
 */
router.get("/history", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const calls = await CallHistory.find({
      $or: [{ caller: userId }, { receiver: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate(
        "caller",
        "_id username name profileImage presenceStatus isOnline isLive isBusy followers following",
      )
      .populate(
        "receiver",
        "_id username name profileImage presenceStatus isOnline isLive isBusy followers following",
      );

    const result = calls.map((call) => {
      const isIncoming = String(call.receiver._id) === String(userId);
      const otherUser = isIncoming ? call.caller : call.receiver;

      return {
        id: call._id,
        user: {
          _id: otherUser._id,
          username: otherUser.username,
          name: otherUser.name || otherUser.username,
          profileImage: otherUser.profileImage || "",
          presenceStatus: otherUser.presenceStatus || "offline",
          isOnline: otherUser.isOnline || false,
          isLive: otherUser.isLive || false,
          isBusy: otherUser.isBusy || false,
          followers: otherUser.followers || 0,
          following: otherUser.following || 0,
        },
        isIncoming,
        time: call.startedAt || call.createdAt,
        durationSec: call.durationSec || 0,
        isMissed: call.status === "missed" || call.status === "cancelled",
        isVideo: call.type !== "audio",
        type: call.type,
        status: call.status,
      };
    });

    res.json({ success: true, calls: result });
  } catch (error) {
    logger.error("❌ Call history error:", error);
    sendError(res, 500, "Sunucu hatası");
  }
});

module.exports = router;
