/**
 * Live stream socket event handlers.
 * Handles join_room, leave_room, chat_message, pin/unpin, mute/unmute.
 */

const LiveStream = require("../models/LiveStream");
const Message = require("../models/Message");
const User = require("../models/User");
const { emitToUserSockets } = require("./helpers");
const { userSockets } = require("./state");
const { sanitizeSocketPayload } = require("../middleware/validate");
const { logger } = require("../utils/logger");
const {
  containsPaymentRedirect,
} = require("../utils/paymentRedirectModeration");
const {
  recordPaymentRedirectAttempt,
} = require("../services/moderationAuditService");

const mutedUsersByRoom = new Map();

function getRoomMuteMap(roomId) {
  const key = String(roomId || "").trim();
  if (!mutedUsersByRoom.has(key)) {
    mutedUsersByRoom.set(key, new Map());
  }
  return mutedUsersByRoom.get(key);
}

function getMuteExpiry(roomId, userId) {
  const roomMuteMap = mutedUsersByRoom.get(String(roomId || "").trim());
  if (!roomMuteMap) return null;
  return roomMuteMap.get(String(userId || "").trim()) ?? null;
}

function setMuteExpiry(roomId, userId, expiresAt) {
  const roomMuteMap = getRoomMuteMap(roomId);
  roomMuteMap.set(String(userId || "").trim(), expiresAt);
}

function clearMute(roomId, userId) {
  const roomKey = String(roomId || "").trim();
  const roomMuteMap = mutedUsersByRoom.get(roomKey);
  if (!roomMuteMap) return;
  roomMuteMap.delete(String(userId || "").trim());
  if (roomMuteMap.size === 0) {
    mutedUsersByRoom.delete(roomKey);
  }
}

/**
 * Register live stream events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance
 */
function register(socket, io) {
  // İzleyici yayın odasına katılıyor
  socket.on("live:join_room", async (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId) {
      logger.debug("live:join_room - missing roomId or userId");
      return;
    }

    try {
      socket.join(roomId);
      logger.debug(`User ${userId} joined live room: ${roomId}`);
      // NOT: viewer_joined event'i joinAsViewer HTTP endpoint'inde emit ediliyor.
      // Burada tekrar emit etmiyoruz, double event önlenir.
    } catch (e) {
      logger.error("live:join_room error", { err: e.message });
      socket.emit("error", { message: "join_room_failed" });
    }
  });

  // İzleyici yayın odasından ayrılıyor
  socket.on("live:leave_room", async (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId) {
      logger.debug("live:leave_room - missing roomId or userId");
      return;
    }

    try {
      socket.leave(roomId);
      logger.debug(`User ${userId} left live room: ${roomId}`);

      // NOT: viewerCount azaltma leaveAsViewer HTTP endpoint'inde yapılıyor.
      // Socket sadece room'dan leave olur, double count önlenir.
      const stream = await LiveStream.findOne({ roomId })
        .select("viewerCount")
        .lean();

      if (stream) {
        socket.to(roomId).emit("viewer_left", {
          roomId,
          userId,
          viewerCount: stream.viewerCount,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      logger.error("live:leave_room error", { err: e.message });
      socket.emit("error", { message: "leave_room_failed" });
    }
  });

  // Yayın içi chat mesajı (real-time)
  socket.on("live:chat_message", async (rawData) => {
    const { roomId, message, type = "text" } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId || !message) {
      logger.debug("live:chat_message - missing required fields");
      return;
    }

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) {
        socket.emit("error", { message: "stream_not_found" });
        return;
      }

      const mutedUntil = getMuteExpiry(roomId, userId);
      if (mutedUntil && mutedUntil > Date.now()) {
        socket.emit("user_muted", {
          roomId,
          mutedUserId: String(userId),
          mutedUntil: new Date(mutedUntil),
          duration: Math.max(Math.ceil((mutedUntil - Date.now()) / 1000), 1),
        });
        return;
      }
      if (mutedUntil && mutedUntil <= Date.now()) {
        clearMute(roomId, userId);
      }

      if (message.length > 500) {
        socket.emit("error", { message: "message_too_long" });
        return;
      }

      if (containsPaymentRedirect(String(message))) {
        await recordPaymentRedirectAttempt({
          source: "live_chat_socket",
          actorUserId: userId,
          roomId,
          content: String(message),
        });
        socket.emit("error", { message: "payment_redirect_blocked" });
        return;
      }

      const user = await User.findById(userId)
        .select("username name profileImage")
        .lean();
      if (!user) {
        socket.emit("error", { message: "user_not_found" });
        return;
      }

      const sanitizedContent = String(message).replace(/<[^>]*>/g, "");

      const msg = await Message.create({
        roomId,
        from: userId,
        type,
        content: sanitizedContent,
      });
      io.to(roomId).emit("chat_message", {
        _id: msg._id,
        roomId,
        type,
        content: sanitizedContent,
        sender: {
          _id: userId,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
        },
        timestamp: msg.createdAt,
      });
    } catch (e) {
      logger.error("live:chat_message error", { err: e.message });
      socket.emit("error", { message: "chat_send_failed" });
    }
  });

  // Pinned message
  socket.on("live:pin_message", async (rawData) => {
    const { roomId, messageId, content } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || !userId) return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) return;

      if (stream.host.toString() !== userId) {
        socket.emit("error", { message: "only_host_can_pin" });
        return;
      }

      io.to(roomId).emit("message_pinned", {
        roomId,
        messageId,
        content,
        pinnedAt: new Date(),
      });

      logger.debug(`Message pinned in room ${roomId}`);
    } catch (e) {
      logger.error("live:pin_message error", { err: e.message });
    }
  });

  // Unpin message
  socket.on("live:unpin_message", async (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || !userId) return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream || stream.host.toString() !== userId) return;

      io.to(roomId).emit("message_unpinned", { roomId });
      logger.debug(`Message unpinned in room ${roomId}`);
    } catch (e) {
      logger.error("live:unpin_message error", { err: e.message });
    }
  });

  // Mute user
  socket.on("live:mute_user", async (rawData) => {
    const {
      roomId,
      targetUserId,
      duration = 300,
    } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (
      !roomId ||
      typeof roomId !== "string" ||
      !userId ||
      !targetUserId ||
      typeof targetUserId !== "string"
    )
      return;

    try {
      const stream = await LiveStream.findOne({
        roomId,
        isLive: true,
      }).lean();
      if (!stream) return;

      if (stream.host.toString() !== userId) {
        socket.emit("error", { message: "only_host_can_mute" });
        return;
      }

      const expiresAt = Date.now() + duration * 1000;
      setMuteExpiry(roomId, targetUserId, expiresAt);

      io.to(roomId).emit("user_muted", {
        roomId,
        mutedUserId: targetUserId,
        mutedUntil: new Date(expiresAt),
        duration,
      });

      logger.debug(
        `User ${targetUserId} muted for ${duration}s in room ${roomId}`,
      );
    } catch (e) {
      logger.error("live:mute_user error", { err: e.message });
    }
  });

  // Unmute user
  socket.on("live:unmute_user", async (rawData) => {
    const { roomId, targetUserId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (
      !roomId ||
      typeof roomId !== "string" ||
      !userId ||
      !targetUserId ||
      typeof targetUserId !== "string"
    )
      return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream || stream.host.toString() !== userId) return;

      clearMute(roomId, targetUserId);

      io.to(roomId).emit("user_unmuted", {
        roomId,
        unmutedUserId: targetUserId,
      });

      logger.debug(`User ${targetUserId} unmuted in room ${roomId}`);
    } catch (e) {
      logger.error("live:unmute_user error", { err: e.message });
    }
  });

  socket.on("live:kick_user", async (rawData) => {
    const { roomId, targetUserId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (
      !roomId ||
      typeof roomId !== "string" ||
      !userId ||
      !targetUserId ||
      typeof targetUserId !== "string"
    )
      return;

    try {
      const stream = await LiveStream.findOne({ roomId, isLive: true }).lean();
      if (!stream) return;

      if (stream.host.toString() !== userId) {
        socket.emit("error", { message: "only_host_can_kick" });
        return;
      }

      const targetId = String(targetUserId);
      const updatedStream = await LiveStream.findOneAndUpdate(
        { roomId, viewers: targetId },
        {
          $inc: { viewerCount: -1 },
          $pull: { viewers: targetId },
        },
        { new: true },
      )
        .select("viewerCount")
        .lean();

      const nextViewerCount = Math.max(
        updatedStream?.viewerCount ?? stream.viewerCount ?? 0,
        0,
      );

      if (updatedStream && updatedStream.viewerCount < 0) {
        await LiveStream.updateOne({ roomId }, { $set: { viewerCount: 0 } });
      }

      const targetSockets = userSockets.get(targetId);
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach((sid) => {
          const targetSocket = io.sockets.sockets.get(sid);
          if (targetSocket) {
            targetSocket.leave(roomId);
          }
        });
      }

      clearMute(roomId, targetId);

      io.to(roomId).emit("viewer_left", {
        roomId,
        userId: targetId,
        viewerCount: nextViewerCount,
        kicked: true,
      });

      const kickDelivered = emitToUserSockets(targetId, "live:kicked", {
        roomId,
        kickedUserId: targetId,
        message: "Yayından çıkarıldınız",
      });

      const targetSocketsForLog = userSockets.get(targetId);
      logger.info(`User ${targetId} kicked from room ${roomId}`, {
        delivered: kickDelivered,
        sockets: targetSocketsForLog ? targetSocketsForLog.size : 0,
      });
    } catch (e) {
      logger.error("live:kick_user error", { err: e.message });
    }
  });
}

module.exports = { register };
