// src/routes/supportRoutes.js
const express = require("express");
const router = express.Router();
const supportController = require("../controllers/supportController");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");

// =============================================
// KULLANICI ENDPOINT'LERİ (auth gerekli)
// =============================================

// POST /api/support - Yeni destek talebi oluştur
router.post("/", auth, supportController.createTicket);

// GET /api/support/my - Kendi taleplerini getir
router.get("/my", auth, supportController.getMyTickets);

// POST /api/support/:ticketId/reply - Kullanıcı yanıtı
router.post("/:ticketId/reply", auth, supportController.userReply);

// =============================================
// ADMIN ENDPOINT'LERİ (admin yetkisi gerekli)
// =============================================

// GET /api/support/admin - Tüm talepleri listele
router.get("/admin", auth, requirePermission("reports:view"), supportController.getAdminTickets);

// GET /api/support/admin/:ticketId - Tek talep detayı
router.get("/admin/:ticketId", auth, requirePermission("reports:view"), supportController.getTicketById);

// POST /api/support/admin/send-to-user - Admin proaktif mesaj (hosts bölümünden)
router.post("/admin/send-to-user", auth, requirePermission("users:edit"), supportController.adminSendToUser);

// POST /api/support/admin/:ticketId/reply - Admin yanıtı
router.post("/admin/:ticketId/reply", auth, requirePermission("reports:view"), supportController.adminReply);

// PATCH /api/support/admin/:ticketId/status - Durum güncelle
router.patch("/admin/:ticketId/status", auth, requirePermission("reports:view"), supportController.updateTicketStatus);

// DELETE /api/support/admin/:ticketId - Talebi sil
router.delete("/admin/:ticketId", auth, requirePermission("reports:view"), supportController.deleteTicket);

module.exports = router;
