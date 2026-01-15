// src/routes/giftRoutes.js
const express = require("express");
const router = express.Router();
const giftController = require("../controllers/giftController");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const { giftLimiter } = require("../middleware/rateLimit");

// ============ PUBLIC ENDPOINTS ============
// Tüm hediyeleri getir (kategori filtresi opsiyonel)
router.get("/", giftController.getGifts);

// ============ USER ENDPOINTS ============
// Hediye gönder (rate limited)
router.post("/send", auth, giftLimiter, giftController.sendGift);

// Kullanıcının gönderdiği hediye geçmişi
router.get("/history/sent", auth, giftController.getMyGiftHistory);

// Kullanıcının aldığı hediyeler
router.get("/history/received", auth, giftController.getReceivedGifts);

// Yayın için hediye istatistikleri
router.get("/stats/:liveId", auth, giftController.getLiveGiftStats);

// ============ ADMIN ENDPOINTS ============
// Yeni hediye oluştur
router.post("/admin/create", auth, admin, giftController.createGift);

// Hediye güncelle
router.put("/admin/:giftId", auth, admin, giftController.updateGift);

// Hediye sil
router.delete("/admin/:giftId", auth, admin, giftController.deleteGift);

// Default hediyeleri seed et
router.post("/admin/seed", auth, admin, giftController.seedGifts);

module.exports = router;
