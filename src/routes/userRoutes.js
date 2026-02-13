// src/routes/userRoutes.js
const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const blockController = require("../controllers/blockController");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const multer = require("multer");

// Multer konfigürasyonu - avatar yükleme için
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Sadece resim dosyaları yüklenebilir"), false);
    }
  }
});

// Optional auth middleware
const optionalAuth = (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (token) {
    return auth(req, res, next);
  }
  next();
};

// =============================================
// KENDİ PROFİL ENDPOINT'LERİ (auth gerekli)
// =============================================

// GET /api/users/me - Kendi profilini getir
router.get("/me", auth, userController.getMyProfile);

// PUT /api/users/me - Profil güncelle
router.put("/me", auth, userController.updateMyProfile);

// DELETE /api/users/me - Hesap sil
router.delete("/me", auth, userController.deleteAccount);

// POST /api/users/me/avatar - Avatar yükle
router.post("/me/avatar", auth, upload.single("avatar"), userController.uploadAvatar);

// DELETE /api/users/me/avatar - Avatar sil
router.delete("/me/avatar", auth, userController.deleteAvatar);

// GET /api/users/me/stats - İstatistikleri getir
router.get("/me/stats", auth, userController.getMyStats);

// GET /api/users/me/followers - Takipçileri getir
router.get("/me/followers", auth, userController.getMyFollowers);

// GET /api/users/me/following - Takip edilenleri getir
router.get("/me/following", auth, userController.getMyFollowing);

// GET /api/users/me/visitors - Ziyaretçileri getir
router.get("/me/visitors", auth, userController.getMyVisitors);

// PUT /api/users/me/settings - Ayarları güncelle
router.put("/me/settings", auth, userController.updateSettings);

// POST /api/users/me/freeze - Hesabı dondur
router.post("/me/freeze", auth, userController.freezeAccount);

// GET /api/users/me/blocked - Engellenen kullanıcılar
router.get("/me/blocked", auth, blockController.getBlockedUsers);

// =============================================
// GENEL KULLANICI ENDPOINT'LERİ
// =============================================

// ADMIN: Tüm kullanıcıları listele (pagination + search)
router.get("/admin", auth, requirePermission("users:view"), userController.getAdminUsers);

// GET /api/users - Tüm kullanıcıları getir (search query destekli)
router.get("/", optionalAuth, userController.getUsers);

// GET /api/users/females - Cinsiyete göre kullanıcıları getir
router.get("/females", optionalAuth, userController.getFemaleUsers);

// GET /api/users/vip - VIP kullanıcıları getir
router.get("/vip", optionalAuth, userController.getVipUsers);

// GET /api/users/:userId - Tek bir kullanıcıyı getir
router.get("/:userId", optionalAuth, userController.getUserById);

// =============================================
// KULLANICI İŞLEMLERİ (auth gerekli)
// =============================================

// POST /api/users/:userId/follow - Takip et
router.post("/:userId/follow", auth, userController.followUser);

// DELETE /api/users/:userId/follow - Takipten çık
router.delete("/:userId/follow", auth, userController.unfollowUser);

// GET /api/users/:userId/is-following - Takip durumu kontrol
router.get("/:userId/is-following", auth, userController.isFollowing);

// POST /api/users/:userId/visit - Profil ziyareti kaydet
router.post("/:userId/visit", auth, userController.visitProfile);

// POST /api/users/:userId/block - Kullanıcı engelle
router.post("/:userId/block", auth, blockController.blockUser);

// DELETE /api/users/:userId/block - Engel kaldır
router.delete("/:userId/block", auth, blockController.unblockUser);

// GET /api/users/:userId/is-blocked - Engel durumu kontrol
router.get("/:userId/is-blocked", auth, blockController.isBlocked);

// PUT /api/users/:userId/visibility - Görünürlük güncelle
router.put("/:userId/visibility", auth, userController.updateVisibility);

// PUT /api/users/:userId/status - Durum güncelle (online/offline)
router.put("/:userId/status", auth, userController.updateUserStatus);

// POST /api/users/:userId/start-broadcast - Yayın başlat
router.post("/:userId/start-broadcast", auth, userController.startBroadcast);

// POST /api/users/:userId/end-broadcast - Yayın sonlandır
router.post("/:userId/end-broadcast", auth, userController.endBroadcast);

// =============================================
// ADMIN ENDPOINT'LERİ
// =============================================

// PATCH /api/users/:userId/ban - Ban toggle
router.patch("/:userId/ban", auth, requirePermission("users:ban"), userController.toggleBan);

// PATCH /api/users/:userId/unban - Unban
router.patch("/:userId/unban", auth, requirePermission("users:ban"), userController.unbanUser);

// DELETE /api/users/:userId - Admin kullanıcı sil
router.delete("/:userId", auth, requirePermission("users:ban"), userController.adminDeleteUser);

// PATCH /api/users/:userId/coins - Coin güncelle (set)
router.patch("/:userId/coins", auth, requirePermission("users:edit"), userController.updateCoins);

// POST /api/users/:userId/add-coins - Coin ekle (increment)
router.post("/:userId/add-coins", auth, requirePermission("users:edit"), userController.addCoins);

module.exports = router;