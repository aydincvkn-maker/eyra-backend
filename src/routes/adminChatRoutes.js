// src/routes/adminChatRoutes.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const AdminMessage = require("../models/AdminMessage");
const { sendSuccess, sendError } = require("../utils/response");

const allowedAdminChatMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/aac",
  "audio/x-m4a",
  "audio/m4a",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "application/zip",
  "application/x-rar-compressed",
  "application/vnd.rar",
]);

const allowedAdminChatExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".mp4a",
  ".m4a",
  ".ogg",
  ".wav",
  ".aac",
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".zip",
  ".rar",
]);

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimeType = String(file.mimetype || "").toLowerCase();
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (
      allowedAdminChatMimeTypes.has(mimeType)
      || allowedAdminChatExtensions.has(extension)
    ) {
      return cb(null, true);
    }

    return cb(new Error("Bu dosya türü desteklenmiyor"), false);
  },
});

function inferAttachmentType(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function normalizeAttachment(rawAttachment) {
  if (!rawAttachment) return null;

  const attachment = typeof rawAttachment === "string"
    ? JSON.parse(rawAttachment)
    : rawAttachment;

  const url = String(attachment.url || "").trim();
  const type = String(attachment.type || "file").trim();
  const fileName = String(attachment.fileName || "Ek dosya").trim();
  const mimeType = String(attachment.mimeType || "application/octet-stream").trim();
  const fileSize = Number(attachment.fileSize || 0);

  if (!url || !url.startsWith("/uploads/admin-chat/")) {
    throw new Error("Geçersiz ek dosya yolu");
  }

  if (!["image", "video", "audio", "file"].includes(type)) {
    throw new Error("Geçersiz ek dosya türü");
  }

  return {
    url,
    type,
    fileName: fileName || "Ek dosya",
    fileSize: Number.isFinite(fileSize) ? fileSize : 0,
    mimeType: mimeType || "application/octet-stream",
  };
}

function buildMessagePayload(message) {
  return {
    _id: message._id,
    senderId: message.senderId,
    senderName: message.senderName,
    senderRole: message.senderRole,
    content: message.content,
    attachment: message.attachment || null,
    threadType: message.threadType,
    recipientId: message.recipientId,
    createdAt: message.createdAt,
  };
}

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

function buildVisibleMessagesFilter(filter, viewerId) {
  return {
    $and: [
      filter,
      {
        deletedFor: { $nin: [viewerId] },
      },
    ],
  };
}

function emitThreadCleared(adminNamespace, threadType, actorId, recipientId = null) {
  const payload = {
    threadType,
    actorId: String(actorId),
    recipientId: recipientId ? String(recipientId) : null,
    participantIds: recipientId ? [String(actorId), String(recipientId)] : [],
  };

  adminNamespace.emitToAdminUser(actorId, "admin-chat:cleared", payload);
}

// Tüm route'lar admin auth gerektirir
router.use(auth);
router.use(admin);

// POST /api/admin-chat/upload — Dosya/resim yükle
router.post("/upload", attachmentUpload.single("media"), async (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, "Dosya yüklenmedi");
    }

    const file = req.file;
    const extension = path.extname(file.originalname || "").toLowerCase();
    const mimeType = String(file.mimetype || "application/octet-stream").toLowerCase();
    const attachmentType = inferAttachmentType(mimeType);
    const folder = attachmentType === "file" ? "files" : `${attachmentType}s`;
    const timestamp = Date.now();
    const fileName = `admin_${String(req.user.id)}_${timestamp}${extension}`;
    const uploadDir = path.join(__dirname, `../../uploads/admin-chat/${folder}`);

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, file.buffer);

    return sendSuccess(res, {
      attachment: {
        url: `/uploads/admin-chat/${folder}/${fileName}`,
        type: attachmentType,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType,
      },
    }, 201);
  } catch (err) {
    return sendError(res, 500, err.message || "Dosya yüklenemedi");
  }
});

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

      filter = buildVisibleMessagesFilter(buildDirectThreadFilter(myId, requestedRecipientId), myId);
    } else {
      filter = buildVisibleMessagesFilter(buildGroupThreadFilter(), myId);
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
    const attachment = normalizeAttachment(req.body.attachment);

    if (content.length > 2000) {
      return sendError(res, 400, "Mesaj 1-2000 karakter arası olmalı");
    }

    if (!content && !attachment) {
      return sendError(res, 400, "Mesaj veya ek dosya göndermelisiniz");
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
      attachment,
      threadType: recipientId ? "direct" : "group",
      recipientId,
    });

    const payload = buildMessagePayload(message);

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

    const adminNamespace = require("../socket/adminNamespace");
    const isDirectMessage = msg.threadType === "direct" || Boolean(msg.recipientId);

    if (isSuperAdmin && !isSelf) {
      await AdminMessage.findByIdAndDelete(req.params.id);

      if (isDirectMessage) {
        adminNamespace.emitToAdminUser(msg.senderId, "admin-chat:deleted", { messageId: req.params.id });
        adminNamespace.emitToAdminUser(msg.recipientId, "admin-chat:deleted", { messageId: req.params.id });
      } else {
        adminNamespace.emit("admin-chat:deleted", { messageId: req.params.id });
      }

      return sendSuccess(res, { deleted: true, scope: "global" });
    }

    await AdminMessage.findByIdAndUpdate(req.params.id, {
      $addToSet: { deletedFor: req.user.id },
    });

    adminNamespace.emitToAdminUser(req.user.id, "admin-chat:deleted", {
      messageId: req.params.id,
      actorId: String(req.user.id),
      threadType: isDirectMessage ? "direct" : "group",
    });

    sendSuccess(res, { deleted: true, scope: "self" });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// DELETE /api/admin-chat/messages — Aktif thread'deki tüm mesajları sil
router.delete("/messages", async (req, res) => {
  try {
    const requestedRecipientId = String(req.query.recipientId || "").trim();
    const myId = String(req.user.id);

    let filter;
    let threadType;

    if (requestedRecipientId) {
      if (!mongoose.Types.ObjectId.isValid(requestedRecipientId)) {
        return sendError(res, 400, "Geçersiz alıcı kimliği");
      }

      filter = buildVisibleMessagesFilter(buildDirectThreadFilter(myId, requestedRecipientId), myId);
      threadType = "direct";
    } else {
      filter = buildVisibleMessagesFilter(buildGroupThreadFilter(), myId);
      threadType = "group";
    }

    const result = await AdminMessage.updateMany(filter, {
      $addToSet: { deletedFor: req.user.id },
    });
    const adminNamespace = require("../socket/adminNamespace");

    emitThreadCleared(
      adminNamespace,
      threadType,
      myId,
      requestedRecipientId || null,
    );

    sendSuccess(res, {
      deleted: true,
      deletedCount: result.modifiedCount || 0,
      threadType,
      scope: "self",
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

module.exports = router;
