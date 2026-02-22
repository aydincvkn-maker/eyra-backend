// src/controllers/chatController.js
const Message = require("../models/Message");
const chatService = require("../services/chatService");
const { getChatRoomId } = require("../utils/chatUtils");
const path = require("path");
const fs = require("fs");

// Legacy/live room messages
exports.getRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(200);
    res.json(messages);
  } catch (err) {
    console.error("getRoomMessages error:", err);
    res.status(500).json({ message: "Sunucu hatası" });
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
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

// Virtual sender ID for all admin-panel messages (shown as "Eyra Destek" in app)
const EYRA_SUPPORT_ID = 'eyra_support';

exports.getConversation = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    const page = Number(req.query.page || 0);
    const limit = Number(req.query.limit || 50);

    if (!otherUserId) {
      return res.status(400).json({ message: "Eksik userId" });
    }

    // ✅ Special case: fetch all admin-panel messages sent to this user
    if (otherUserId === EYRA_SUPPORT_ID) {
      const messages = await Message.find({
        to: userId,
        'metadata.isAdminMessage': true,
        isDeleted: false,
      })
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit)
        .select('-__v')
        .lean();

      // Normalise: expose virtual sender id so Flutter groups them correctly
      const normalised = messages.reverse().map(m => ({
        ...m,
        from: EYRA_SUPPORT_ID,
        isAdminMessage: true,
        senderName: 'Eyra Destek',
      }));
      return res.json({ messages: normalised });
    }

    const messages = await chatService.getConversation(userId, otherUserId, page, limit);
    return res.json({ messages });
  } catch (err) {
    console.error("getConversation error:", err);
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const fromUserId = String(req.user?.id || "");
    const toUserId = String(req.body?.to || "").trim();

    if (!toUserId) {
      return res.status(400).json({ message: "Eksik alıcı (to)" });
    }

    const message = await chatService.sendMessage(fromUserId, toUserId, {
      text: req.body?.text,
      replyToId: req.body?.replyToId,
      mediaUrl: req.body?.mediaUrl,
      mediaType: req.body?.mediaType,
    });

    return res.status(201).json({ message });
  } catch (err) {
    console.error("sendMessage error:", err);
    if (err.message === "RATE_LIMIT_EXCEEDED") {
      return res.status(429).json({ message: "RATE_LIMIT" });
    }
    if (err.message === "USER_BLOCKED") {
      return res.status(403).json({ message: "USER_BLOCKED" });
    }
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.deleteConversation = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    if (!otherUserId) {
      return res.status(400).json({ message: "Eksik userId" });
    }
    await chatService.deleteConversation(userId, otherUserId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteConversation error:", err);
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    if (!otherUserId) {
      return res.status(400).json({ message: "Eksik userId" });
    }
    await chatService.markAsRead(userId, otherUserId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("markAsRead error:", err);
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    if (!otherUserId) {
      return res.status(400).json({ message: "Eksik userId" });
    }

    const roomId = getChatRoomId(userId, otherUserId);
    const unreadCount = await Message.countDocuments({
      roomId,
      from: otherUserId,
      to: userId,
      isDeleted: false,
      'metadata.readAt': { $exists: false },
    });

    return res.json({ unreadCount });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.deleteMessage = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    if (!messageId) return res.status(400).json({ message: "Eksik messageId" });
    await chatService.deleteMessage(messageId, userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteMessage error:", err);
    if (err.message === 'MESSAGE_NOT_FOUND') return res.status(404).json({ message: 'MESSAGE_NOT_FOUND' });
    if (err.message === 'UNAUTHORIZED') return res.status(403).json({ message: 'UNAUTHORIZED' });
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.editMessage = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    const newText = String(req.body?.text || "");
    if (!messageId) return res.status(400).json({ message: "Eksik messageId" });
    const message = await chatService.editMessage(messageId, userId, newText);
    return res.json({ message });
  } catch (err) {
    console.error("editMessage error:", err);
    if (err.message === 'MESSAGE_NOT_FOUND') return res.status(404).json({ message: 'MESSAGE_NOT_FOUND' });
    if (err.message === 'UNAUTHORIZED') return res.status(403).json({ message: 'UNAUTHORIZED' });
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.addReaction = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    const emoji = String(req.body?.emoji || "");
    if (!messageId) return res.status(400).json({ message: "Eksik messageId" });
    const message = await chatService.addReaction(messageId, userId, emoji);
    return res.json({ message });
  } catch (err) {
    console.error("addReaction error:", err);
    if (err.message === 'MESSAGE_NOT_FOUND') return res.status(404).json({ message: 'MESSAGE_NOT_FOUND' });
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.removeReaction = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const messageId = String(req.params.messageId || "").trim();
    if (!messageId) return res.status(400).json({ message: "Eksik messageId" });
    const message = await chatService.removeReaction(messageId, userId);
    return res.json({ message });
  } catch (err) {
    console.error("removeReaction error:", err);
    if (err.message === 'MESSAGE_NOT_FOUND') return res.status(404).json({ message: 'MESSAGE_NOT_FOUND' });
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

// Admin: Send message to a specific user
exports.adminSendMessage = async (req, res) => {
  try {
    const adminId = String(req.user?.id || "");
    const { toUserId, text } = req.body;

    if (!toUserId || !text) {
      return res.status(400).json({ message: "toUserId ve text gerekli" });
    }

    const message = await chatService.sendMessage(adminId, toUserId, { text, isAdmin: true });

    // Socket ile gerçek zamanlı bildirim
    if (global.io && global.userSockets) {
      const targetKey = String(toUserId);
      const targetSockets = global.userSockets.get(targetKey);
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach(socketId => {
          global.io.to(socketId).emit('chat:new_message', {
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
    return res.status(500).json({ message: "Sunucu hatası" });
  }
};

// =========================
// MEDYA YÜKLEME
// =========================

exports.uploadMedia = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Dosya yüklenmedi" });
    }

    const file = req.file;
    const ext = path.extname(file.originalname);
    const timestamp = Date.now();
    
    // Dosya tipine göre klasör
    let folder = "files";
    if (file.mimetype.startsWith("image/")) folder = "images";
    else if (file.mimetype.startsWith("video/")) folder = "videos";
    else if (file.mimetype.startsWith("audio/")) folder = "audio";

    const fileName = `chat_${userId}_${timestamp}${ext}`;
    const uploadDir = path.join(__dirname, `../../uploads/chat/${folder}`);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, file.buffer);
    const fileUrl = `/uploads/chat/${folder}/${fileName}`;

    // Dosya tipi belirleme
    let messageType = "file";
    if (file.mimetype.startsWith("image/")) messageType = "image";
    else if (file.mimetype.startsWith("video/")) messageType = "video";
    else if (file.mimetype.startsWith("audio/")) messageType = "audio";

    res.json({
      success: true,
      url: fileUrl,
      type: messageType,
      fileName: file.originalname,
      fileSize: file.size,
      mimeType: file.mimetype,
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
      return res.status(400).json({ success: false, message: "Hedef kullanıcı(lar) gerekli" });
    }

    // Orijinal mesajı bul
    const originalMessage = await Message.findById(messageId);
    if (!originalMessage) {
      return res.status(404).json({ success: false, message: "Mesaj bulunamadı" });
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
            targetSockets.forEach(socketId => {
              global.io.to(socketId).emit('chat:new_message', {
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
