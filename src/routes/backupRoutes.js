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
    const result = await backupCron.runBackup({
      trigger: "manual",
      reason: `manual:${req.user.username}`,
    });
    const statusCode = result.errors.length === 0 ? 200 : 207;
    return sendSuccess(res, {
      message:
        result.errors.length === 0
          ? "Backup tamamlandı"
          : "Backup kısmi tamamlandı. Hatalı koleksiyonları kontrol edin.",
      ...result,
    }, statusCode);
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
    const { backupId, dateKey, collections } = req.body;
    const targetBackup = String(backupId || dateKey || "").trim();
    const restoreCollections = Array.isArray(collections) ? collections : null;
    if (!targetBackup || typeof targetBackup !== "string") {
      return sendError(res, 400, "Geçerli bir backup kimliği gerekli");
    }

    logger.warn(
      `⚠️ RESTORE başlatıldı — backup: ${targetBackup}, koleksiyonlar: ${
        restoreCollections ? restoreCollections.join(", ") : "TÜMÜ"
      }, kullanıcı: ${req.user.username}`
    );

    const result = await backupCron.restoreBackup(targetBackup, restoreCollections);
    const statusCode = result.errors.length === 0 ? 200 : 207;

    return sendSuccess(res, {
      message:
        result.errors.length === 0
          ? `${result.restoredFrom} backup'ı geri yüklendi`
          : `Restore kısmi tamamlandı. Koruma yedeği: ${result.safetyBackupId}`,
      result,
    }, statusCode);
  } catch (err) {
    logger.error("Restore hatası:", err.message);
    return sendError(res, 500, "Restore sırasında hata oluştu: " + err.message);
  }
});

module.exports = router;
