// src/controllers/chatController.js
const Message = require("../models/Message");
const chatService = require("../services/chatService");
const { getChatRoomId } = require("../utils/chatUtils");

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

exports.getConversation = async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const otherUserId = String(req.params.userId || "").trim();
    const page = Number(req.query.page || 0);
    const limit = Number(req.query.limit || 50);

    if (!otherUserId) {
      return res.status(400).json({ message: "Eksik userId" });
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
