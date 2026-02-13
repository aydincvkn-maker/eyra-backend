// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const multer = require("multer");

// Multer konfigürasyonu - chat medya yükleme
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "video/mp4", "video/quicktime",
      "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/aac",
      "application/pdf",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Bu dosya türü desteklenmiyor"), false);
    }
  },
});

// Legacy/live room messages
router.get("/room/:roomId", auth, chatController.getRoomMessages);

// Private chat (used by Flutter ChatApiService)
router.get("/users", auth, chatController.getChatUsers);
router.get("/conversation/:userId", auth, chatController.getConversation);
router.post("/send", auth, chatController.sendMessage);
router.post("/read/:userId", auth, chatController.markAsRead);
router.get("/unread/:userId", auth, chatController.getUnreadCount);

// Medya yükleme
router.post("/upload", auth, upload.single("media"), chatController.uploadMedia);

router.delete("/message/:messageId", auth, chatController.deleteMessage);
router.put("/message/:messageId", auth, chatController.editMessage);
router.post("/message/:messageId/reaction", auth, chatController.addReaction);
router.delete("/message/:messageId/reaction", auth, chatController.removeReaction);

// Forward
router.post("/message/:messageId/forward", auth, chatController.forwardMessage);

// Admin: Send message to a user (admin panel → host)
router.post("/admin/send", auth, requirePermission("users:edit"), chatController.adminSendMessage);

module.exports = router;
