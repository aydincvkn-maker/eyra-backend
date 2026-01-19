// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const auth = require("../middleware/auth");

// Legacy/live room messages
router.get("/room/:roomId", auth, chatController.getRoomMessages);

// Private chat (used by Flutter ChatApiService)
router.get("/users", auth, chatController.getChatUsers);
router.get("/conversation/:userId", auth, chatController.getConversation);
router.post("/send", auth, chatController.sendMessage);
router.post("/read/:userId", auth, chatController.markAsRead);
router.get("/unread/:userId", auth, chatController.getUnreadCount);

router.delete("/message/:messageId", auth, chatController.deleteMessage);
router.put("/message/:messageId", auth, chatController.editMessage);
router.post("/message/:messageId/reaction", auth, chatController.addReaction);
router.delete("/message/:messageId/reaction", auth, chatController.removeReaction);

module.exports = router;
