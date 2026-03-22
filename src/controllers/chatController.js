// src/controllers/chatController.js
const Message = require("../models/Message");
const User = require("../models/User");
const chatService = require("../services/chatService");
const { getChatRoomId } = require("../utils/chatUtils");
const { sendError } = require("../utils/response");
const path = require("path");
const fs = require("fs");

// Legacy/live room messages
exports.getRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit || 200))));
    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(limit);
    res.json(messages);
  } catch (err) {
    console.error("getRoomMessages error:", err);
    sendError(res, 500, "Sunucu hatası");
  }
};

// =========================
// PRIVATE CHAT REST API
// =========================

exports.getChatUsers = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const users = await chatService.getChatUsers(userId);
    return res.json({ users });
  } catch (err) {
    console.error("getChatUsers error:", err);
    return sendError(res, 500, "Sunucu hatası");
  }
};

// Virtual sender ID for all admin-panel messages (shown as "Eyra Destek" in app)
const EYRA_SUPPORT_ID = "eyra_support";

exports.getConversation = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    const page = Math.max(0, Math.floor(Number(req.query.page || 0)));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit || 50))));

    if (!otherUserId) {
      return sendError(res, 400, "Eksik userId");
    }

    // ✅ Special case: fetch all admin-panel messages sent to this user
    if (otherUserId === EYRA_SUPPORT_ID) {
      const messages = await Message.find({
        to: userId,
        "metadata.isAdminMessage": true,
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit)
        .select("-__v")
        .lean();

      // Normalise: expose virtual sender id so Flutter groups them correctly
      const normalised = messages.reverse().map((m) => ({
        ...m,
        from: EYRA_SUPPORT_ID,
        isAdminMessage: true,
        senderName: "Eyra Destek",
      }));
      return res.json({ messages: normalised });
    }

    const messages = await chatService.getConversation(
      userId,
      otherUserId,
      page,
      limit,
    );
    return res.json({ messages });
  } catch (err) {
    console.error("getConversation error:", err);
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const fromUserId = String(req.user?.id || "");
    const toUserId = String(req.body?.to || "").trim();

    if (!toUserId) {
      return sendError(res, 400, "Eksik alıcı (to)");
    }

    const message = await chatService.sendMessage(fromUserId, toUserId, {
      text: req.body?.text,
      clientTempId: req.body?.tempId,
      replyToId: req.body?.replyToId,
      mediaUrl: req.body?.mediaUrl,
      mediaType: req.body?.mediaType,
      durationSec: req.body?.durationSec,
    });

    return res.status(201).json({ message });
  } catch (err) {
    console.error("sendMessage error:", err);
    if (err.message === "RATE_LIMIT_EXCEEDED") {
      return sendError(res, 429, "RATE_LIMIT");
    }
    if (err.message === "USER_BLOCKED") {
      return sendError(res, 403, "USER_BLOCKED");
    }
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.deleteConversation = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    if (!otherUserId) {
      return sendError(res, 400, "Eksik userId");
    }
    await chatService.deleteConversation(userId, otherUserId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteConversation error:", err);
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    if (!otherUserId) {
      return sendError(res, 400, "Eksik userId");
    }
    await chatService.markAsRead(userId, otherUserId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("markAsRead error:", err);
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    if (!otherUserId) {
      return sendError(res, 400, "Eksik userId");
    }

    const roomId = getChatRoomId(userId, otherUserId);
    const unreadCount = await Message.countDocuments({
      roomId,
      from: otherUserId,
      to: userId,
      isDeleted: false,
      "metadata.readAt": { $exists: false },
    });

    return res.json({ unreadCount });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.deleteMessage = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    if (!messageId) return sendError(res, 400, "Eksik messageId");
    await chatService.deleteMessage(messageId, userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteMessage error:", err);
    if (err.message === "MESSAGE_NOT_FOUND")
      return sendError(res, 404, "MESSAGE_NOT_FOUND");
    if (err.message === "UNAUTHORIZED")
      return sendError(res, 403, "UNAUTHORIZED");
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.editMessage = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    const newText = String(req.body?.text || "");
    if (!messageId) return sendError(res, 400, "Eksik messageId");
    const message = await chatService.editMessage(messageId, userId, newText);
    return res.json({ message });
  } catch (err) {
    console.error("editMessage error:", err);
    if (err.message === "MESSAGE_NOT_FOUND")
      return sendError(res, 404, "MESSAGE_NOT_FOUND");
    if (err.message === "UNAUTHORIZED")
      return sendError(res, 403, "UNAUTHORIZED");
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.addReaction = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    const emoji = String(req.body?.emoji || "");
    if (!messageId) return sendError(res, 400, "Eksik messageId");
    const message = await chatService.addReaction(messageId, userId, emoji);
    return res.json({ message });
  } catch (err) {
    console.error("addReaction error:", err);
    if (err.message === "MESSAGE_NOT_FOUND")
      return sendError(res, 404, "MESSAGE_NOT_FOUND");
    return sendError(res, 500, "Sunucu hatası");
  }
};

exports.removeReaction = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    if (!messageId) return sendError(res, 400, "Eksik messageId");
    const message = await chatService.removeReaction(messageId, userId);
    return res.json({ message });
  } catch (err) {
    console.error("removeReaction error:", err);
    if (err.message === "MESSAGE_NOT_FOUND")
      return sendError(res, 404, "MESSAGE_NOT_FOUND");
    return sendError(res, 500, "Sunucu hatası");
  }
};

// Admin: Send message to a specific user
exports.adminSendMessage = async (req, res) => {
  try {
    const adminId = String(req.user?.id || "");
    const { toUserId, text } = req.body;

    if (!toUserId || !text) {
      return sendError(res, 400, "toUserId ve text gerekli");
    }

    const message = await chatService.sendMessage(adminId, toUserId, {
      text,
      isAdmin: true,
    });

    // Socket ile gerçek zamanlı bildirim
    if (global.io && global.userSockets) {
      const targetKey = String(toUserId);
      const targetSockets = global.userSockets.get(targetKey);
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach((socketId) => {
          global.io.to(socketId).emit("chat:new_message", {
            messageId: message._id.toString(),
            from: adminId,
            to: toUserId,
            text: message.content,
            timestamp: message.createdAt,
            isMe: false,
          });
        });
      }
    }

    return res.json({ success: true, message });
  } catch (err) {
    console.error("adminSendMessage error:", err);
    return sendError(res, 500, "Sunucu hatası");
  }
};

// =========================
// MEDYA YÜKLEME
// =========================

exports.uploadMedia = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Dosya yüklenmedi" });
    }

    const file = req.file;
    const ext = path.extname(file.originalname || "").toLowerCase();
    const fallbackMimeTypeMap = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".mp3": "audio/mpeg",
      ".aac": "audio/aac",
      ".m4a": "audio/m4a",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".txt": "text/plain",
      ".zip": "application/zip",
      ".rar": "application/vnd.rar",
    };
    const mimeType = String(
      file.mimetype || fallbackMimeTypeMap[ext] || "application/octet-stream",
    ).toLowerCase();
    const timestamp = Date.now();

    // Dosya tipine göre klasör
    let folder = "files";
    if (mimeType.startsWith("image/")) folder = "images";
    else if (mimeType.startsWith("video/")) folder = "videos";
    else if (mimeType.startsWith("audio/")) folder = "audio";

    const fileName = `chat_${userId}_${timestamp}${ext}`;
    const uploadDir = path.join(__dirname, `../../uploads/chat/${folder}`);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, file.buffer);
    const fileUrl = `/uploads/chat/${folder}/${fileName}`;

    // Dosya tipi belirleme
    let messageType = "file";
    if (mimeType.startsWith("image/")) messageType = "image";
    else if (mimeType.startsWith("video/")) messageType = "video";
    else if (mimeType.startsWith("audio/")) messageType = "audio";

    res.json({
      success: true,
      url: fileUrl,
      type: messageType,
      fileName: file.originalname,
      fileSize: file.size,
      mimeType,
    });
  } catch (err) {
    console.error("uploadMedia error:", err);
    res.status(500).json({ success: false, message: "Dosya yüklenemedi" });
  }
};

// =========================
// MESAJ İLETME (FORWARD)
// =========================

exports.forwardMessage = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const { messageId } = req.params;
    const { toUserIds } = req.body; // Birden fazla kişiye iletme

    if (!toUserIds || !Array.isArray(toUserIds) || toUserIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Hedef kullanıcı(lar) gerekli" });
    }

    // Orijinal mesajı bul
    const originalMessage = await Message.findById(messageId);
    if (!originalMessage) {
      return res
        .status(404)
        .json({ success: false, message: "Mesaj bulunamadı" });
    }

    const forwardedMessages = [];

    for (const toUserId of toUserIds) {
      try {
        const roomId = getChatRoomId(userId, toUserId);
        const forwarded = await Message.create({
          roomId,
          from: userId,
          to: toUserId,
          type: originalMessage.type,
          content: originalMessage.content,
          metadata: {
            ...originalMessage.metadata,
            isForwarded: true,
            originalMessageId: String(originalMessage._id),
            originalSender: String(originalMessage.from),
          },
        });

        forwardedMessages.push(forwarded);

        // Socket ile gerçek zamanlı bildirim
        if (global.io && global.userSockets) {
          const targetSockets = global.userSockets.get(String(toUserId));
          if (targetSockets && targetSockets.size > 0) {
            targetSockets.forEach((socketId) => {
              global.io.to(socketId).emit("chat:new_message", {
                messageId: forwarded._id.toString(),
                from: userId,
                to: toUserId,
                text: forwarded.content,
                type: forwarded.type,
                timestamp: forwarded.createdAt,
                isMe: false,
                isForwarded: true,
              });
            });
          }
        }
      } catch (e) {
        console.error(`Forward to ${toUserId} failed:`, e);
      }
    }

    res.json({
      success: true,
      message: `${forwardedMessages.length} kişiye iletildi`,
      forwardedCount: forwardedMessages.length,
    });
  } catch (err) {
    console.error("forwardMessage error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =========================
// RECENT VOICE MESSAGES (for Explore screen)
// =========================

exports.getRecentVoiceMessages = async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, Math.floor(Number(req.query.limit || 10))));

    const messages = await Message.find({
      type: "audio",
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("from", "username name profileImage")
      .lean();

    const result = messages.map((msg) => ({
      id: msg._id,
      from: {
        id: msg.from?._id,
        name: msg.from?.name || msg.from?.username || "User",
        profileImage: msg.from?.profileImage || "",
      },
      mediaUrl: msg.metadata?.mediaUrl || "",
      content: msg.content || "",
      durationSec: msg.metadata?.durationSec || 0,
      createdAt: msg.createdAt,
    }));

    res.json({ success: true, voiceMessages: result });
  } catch (err) {
    console.error("getRecentVoiceMessages error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
