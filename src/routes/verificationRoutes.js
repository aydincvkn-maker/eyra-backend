// src/routes/verificationRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const verificationController = require("../controllers/verificationController");
const multer = require("multer");

// Multer konfigürasyonu - doğrulama fotoğrafı yükleme
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Sadece resim dosyaları yüklenebilir"), false);
    }
  },
});

// Kullanıcı endpoint'leri
router.post("/request", auth, upload.single("selfie"), verificationController.requestVerification);
router.get("/status", auth, verificationController.getVerificationStatus);

// Admin endpoint'leri
router.get("/admin/pending", auth, requirePermission("users:edit"), verificationController.adminGetPending);
router.get("/admin/all", auth, requirePermission("users:edit"), verificationController.adminGetAll);
router.put("/admin/:verificationId/approve", auth, requirePermission("users:edit"), verificationController.adminApprove);
router.put("/admin/:verificationId/reject", auth, requirePermission("users:edit"), verificationController.adminReject);

module.exports = router;
