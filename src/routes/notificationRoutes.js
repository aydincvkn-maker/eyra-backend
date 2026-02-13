// src/routes/notificationRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const notificationController = require("../controllers/notificationController");

// Kullanıcı endpoint'leri
router.get("/", auth, notificationController.getNotifications);
router.get("/unread-count", auth, notificationController.getUnreadCount);
router.put("/:notificationId/read", auth, notificationController.markAsRead);
router.put("/read-all", auth, notificationController.markAllAsRead);
router.delete("/:notificationId", auth, notificationController.deleteNotification);

// FCM Token
router.post("/fcm-token", auth, notificationController.updateFcmToken);
router.delete("/fcm-token", auth, notificationController.removeFcmToken);

// Admin
router.post("/admin/send", auth, requirePermission("system:settings"), notificationController.adminSendNotification);

module.exports = router;
