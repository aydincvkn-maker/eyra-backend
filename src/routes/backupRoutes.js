// src/routes/backupRoutes.js
const router = require("express").Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const { sendSuccess, sendError } = require("../utils/response");
const backupCron = require("../jobs/backupCron");
const { logger } = require("../utils/logger");

// Tüm backup endpoint'leri super_admin gerektirir
function superAdminOnly(req, res, next) {
  if (req.user.role !== "super_admin") {
    return sendError(res, 403, "Bu işlem için super_admin yetkisi gerekli");
  }
  next();
}

// POST /api/admin/backup — Manuel backup tetikle
router.post("/backup", auth, admin, superAdminOnly, async (req, res) => {
  try {
    logger.info(`Manuel backup tetiklendi — kullanıcı: ${req.user.username}`);
    const result = await backupCron.runBackup();
    return sendSuccess(res, {
      message: "Backup tamamlandı",
      ...result,
    });
  } catch (err) {
    logger.error("Manuel backup hatası:", err.message);
    return sendError(res, 500, "Backup sırasında hata oluştu: " + err.message);
  }
});

// GET /api/admin/backups — Mevcut backup listesini getir
router.get("/backups", auth, admin, superAdminOnly, async (req, res) => {
  try {
    const backups = await backupCron.listBackups();
    return sendSuccess(res, { backups });
  } catch (err) {
    logger.error("Backup listeleme hatası:", err.message);
    return sendError(res, 500, "Backup listesi alınamadı");
  }
});

// POST /api/admin/backup/restore — Belirli bir tarihten restore et
router.post("/backup/restore", auth, admin, superAdminOnly, async (req, res) => {
  try {
    const { dateKey, collections } = req.body;
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return sendError(res, 400, "Geçerli bir tarih gerekli (YYYY-MM-DD)");
    }

    logger.warn(
      `⚠️ RESTORE başlatıldı — tarih: ${dateKey}, koleksiyonlar: ${
        collections ? collections.join(", ") : "TÜMÜ"
      }, kullanıcı: ${req.user.username}`
    );

    const results = await backupCron.restoreBackup(dateKey, collections || null);
    return sendSuccess(res, {
      message: `${dateKey} tarihli backup geri yüklendi`,
      results,
    });
  } catch (err) {
    logger.error("Restore hatası:", err.message);
    return sendError(res, 500, "Restore sırasında hata oluştu: " + err.message);
  }
});

module.exports = router;
