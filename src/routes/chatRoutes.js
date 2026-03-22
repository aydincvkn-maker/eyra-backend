// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const { chatLimiter } = require("../middleware/rateLimit");
const multer = require("multer");
const path = require("path");

const allowedChatMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
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

const allowedChatExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".mov",
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

// Multer konfigürasyonu - chat medya yükleme
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
  fileFilter: (req, file, cb) => {
    const mimeType = String(file.mimetype || "").toLowerCase();
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (
      allowedChatMimeTypes.has(mimeType) ||
      allowedChatExtensions.has(extension)
    ) {
      return cb(null, true);
    }

    return cb(new Error("Bu dosya türü desteklenmiyor"), false);
  },
});

// Legacy/live room messages
router.get("/room/:roomId", auth, chatController.getRoomMessages);

// Private chat (used by Flutter ChatApiService)
const {
  validateSendMessage,
} = require("../middleware/validate");

router.get("/users", auth, chatController.getChatUsers);
router.get("/conversation/:userId", auth, chatController.getConversation);
router.delete("/conversation/:userId", auth, chatController.deleteConversation);
router.post(
  "/send",
  auth,
  chatLimiter,
  validateSendMessage,
  chatController.sendMessage,
);
router.post("/read/:userId", auth, chatController.markAsRead);
router.get("/unread/:userId", auth, chatController.getUnreadCount);

// Medya yükleme
router.post(
  "/upload",
  auth,
  chatLimiter,
  upload.single("media"),
  chatController.uploadMedia,
);

router.delete("/message/:messageId", auth, chatController.deleteMessage);
router.put("/message/:messageId", auth, chatController.editMessage);
router.post("/message/:messageId/reaction", auth, chatController.addReaction);
router.delete(
  "/message/:messageId/reaction",
  auth,
  chatController.removeReaction,
);

// Forward
router.post("/message/:messageId/forward", auth, chatController.forwardMessage);

// Recent voice messages for Explore screen
router.get("/voice-messages/recent", auth, chatController.getRecentVoiceMessages);

// Admin: Send message to a user (admin panel → host)
router.post(
  "/admin/send",
  auth,
  requirePermission("users:edit"),
  chatController.adminSendMessage,
);

module.exports = router;
