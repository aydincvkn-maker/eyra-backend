// src/routes/adminChatRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const AdminMessage = require("../models/AdminMessage");
const { sendSuccess, sendError } = require("../utils/response");

function buildDirectThreadFilter(myId, recipientId) {
  return {
    $or: [
      {
        threadType: "direct",
        senderId: myId,
        recipientId,
      },
      {
        threadType: "direct",
        senderId: recipientId,
        recipientId: myId,
      },
      {
        threadType: { $exists: false },
        senderId: myId,
        recipientId,
      },
      {
        threadType: { $exists: false },
        senderId: recipientId,
        recipientId: myId,
      },
    ],
  };
}

function buildGroupThreadFilter() {
  return {
    $or: [
      { threadType: "group" },
      {
        threadType: { $exists: false },
        recipientId: null,
      },
    ],
  };
}

// Tüm route'lar admin auth gerektirir
router.use(auth);
router.use(admin);

// GET /api/admin-chat/messages — Son mesajları getir (sayfalama destekli)
router.get("/messages", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const requestedRecipientId = String(req.query.recipientId || "").trim();
    const myId = String(req.user.id);

    let filter;
    if (requestedRecipientId) {
      if (!mongoose.Types.ObjectId.isValid(requestedRecipientId)) {
        return sendError(res, 400, "Geçersiz alıcı kimliği");
      }

      filter = buildDirectThreadFilter(myId, requestedRecipientId);
    } else {
      filter = buildGroupThreadFilter();
    }

    const [messages, total] = await Promise.all([
      AdminMessage.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdminMessage.countDocuments(filter),
    ]);

    sendSuccess(res, {
      messages: messages.reverse(), // eski → yeni sırada
      pagination: { total, pages: Math.ceil(total / limit), page, limit },
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// POST /api/admin-chat/messages — Yeni mesaj gönder
router.post("/messages", async (req, res) => {
  try {
    const content = String(req.body.content || "").trim();
    if (!content || content.length > 2000) {
      return sendError(res, 400, "Mesaj 1-2000 karakter arası olmalı");
    }

    const rawRecipientId = String(req.body.recipientId || "").trim();
    const recipientId = rawRecipientId || null;
    if (recipientId && !mongoose.Types.ObjectId.isValid(recipientId)) {
      return sendError(res, 400, "Geçersiz alıcı kimliği");
    }

    const message = await AdminMessage.create({
      senderId: req.user.id,
      senderName: req.user.username || req.user.name || "Admin",
      senderRole: req.user.role,
      content,
      threadType: recipientId ? "direct" : "group",
      recipientId,
    });

    const payload = {
      _id: message._id,
      senderId: message.senderId,
      senderName: message.senderName,
      senderRole: message.senderRole,
      content: message.content,
      threadType: message.threadType,
      recipientId: message.recipientId,
      createdAt: message.createdAt,
    };

    const adminNamespace = require("../socket/adminNamespace");
    if (recipientId) {
      adminNamespace.emitToAdminUser(recipientId, "admin-chat:message", payload);
      adminNamespace.emitToAdminUser(req.user.id, "admin-chat:message", payload);
    } else {
      adminNamespace.emit("admin-chat:message", payload);
    }

    sendSuccess(res, { message }, 201);
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// DELETE /api/admin-chat/messages/:id — Kendi mesajını sil
router.delete("/messages/:id", async (req, res) => {
  try {
    const msg = await AdminMessage.findById(req.params.id);
    if (!msg) return sendError(res, 404, "Mesaj bulunamadı");

    // Sadece kendi mesajını silebilir (super_admin hariç)
    const isSelf = String(msg.senderId) === String(req.user.id);
    const isSuperAdmin = req.user.role === "super_admin";
    if (!isSelf && !isSuperAdmin) {
      return sendError(res, 403, "Sadece kendi mesajınızı silebilirsiniz");
    }

    await AdminMessage.findByIdAndDelete(req.params.id);

    const adminNamespace = require("../socket/adminNamespace");
    const isDirectMessage = msg.threadType === "direct" || Boolean(msg.recipientId);

    if (isDirectMessage) {
      adminNamespace.emitToAdminUser(msg.senderId, "admin-chat:deleted", { messageId: req.params.id });
      adminNamespace.emitToAdminUser(msg.recipientId, "admin-chat:deleted", { messageId: req.params.id });
    } else {
      adminNamespace.emit("admin-chat:deleted", { messageId: req.params.id });
    }

    sendSuccess(res, { deleted: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

module.exports = router;
