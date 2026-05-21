// src/controllers/verificationController.js
const Verification = require("../models/Verification");
const User = require("../models/User");
const { createNotification } = require("./notificationController");
const { checkVerificationAchievement } = require("./achievementController");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const storageService = require("../services/storageService");
const { logger } = require("../utils/logger");
const axios = require("axios");

/**
 * Sends a Telegram message to the admin when a new verification request arrives.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 * Silently skips if env vars are not configured.
 */
async function notifyAdminTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: message, parse_mode: "HTML" },
      { timeout: 8000 },
    );
  } catch (err) {
    logger.warn("Telegram admin notify failed", { error: err.message });
  }
}

const saveVerificationUpload = async (userId, file, suffix) => {
  const id = `verify_${userId}_${suffix}_${crypto.randomBytes(8).toString("hex")}`;
  const uploaded = await storageService.uploadBuffer(file.buffer, {
    folder: "verification",
    mimeType: file.mimetype,
    originalName: file.originalname,
    publicId: id,
  });
  return { url: uploaded.url, publicId: uploaded.publicId || id };
};

const cleanupUploads = async (uploaded) => {
  for (const item of uploaded) {
    if (!item || !item.publicId) continue;
    try {
      await storageService.destroy(item.publicId);
    } catch (e) {
      logger.warn("verification cleanup failed", {
        publicId: item.publicId,
        error: e.message,
      });
    }
  }
};

// =============================================
// KULLANICI ENDPOINT'LERİ
// =============================================

// POST /api/verification/profile-photo - Profil fotoğrafı yükleme (Galeri)
exports.uploadProfilePhoto = async (req, res) => {
  try {
    const userId = req.user.id;
    const file = req.file;

    if (!file) {
      return res
        .status(400)
        .json({ success: false, message: "Profil fotoğrafı gerekli" });
    }

    const user = await User.findById(userId).select("isVerified");
    if (user.isVerified) {
      return res
        .status(400)
        .json({ success: false, message: "Zaten doğrulanmış" });
    }

    // Eski profil foto'su varsa temizle
    const oldUser = await User.findById(userId).select(
      "profileImage profileImagePublicId",
    );
    if (oldUser.profileImagePublicId) {
      try {
        await storageService.destroy(oldUser.profileImagePublicId);
      } catch (e) {
        logger.warn("Old profile photo cleanup failed", {
          userId,
          error: e.message,
        });
      }
    }

    // Yeni profil fotosunu upload et
    const id = `profile_${userId}_${crypto.randomBytes(6).toString("hex")}`;
    const uploaded = await storageService.uploadBuffer(file.buffer, {
      folder: "profile",
      mimeType: file.mimetype,
      originalName: file.originalname,
      publicId: id,
    });

    // Kullanıcıyı güncelle
    const updated = await User.findByIdAndUpdate(
      userId,
      {
        profileImage: uploaded.url,
        profileImagePublicId: uploaded.publicId || id,
      },
      { new: true, select: "profileImage" },
    );

    logger.info("Profile photo uploaded", { userId, publicId: id });
    return res.json({
      success: true,
      message: "Profil fotoğrafı başarıyla yüklendi",
      profileImage: updated.profileImage,
    });
  } catch (err) {
    logger.error("uploadProfilePhoto error:", err);
    return res.status(500).json({
      success: false,
      message: "Profil fotoğrafı yüklemesi başarısız",
    });
  }
};

// POST /api/verification/face-photos - Yüz fotoğrafları yükleme (Kamera - sağ, sol, ön)
exports.uploadFacePhotos = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select(
      "isVerified verificationStatus gender profileImage",
    );
    if (user.isVerified) {
      return res
        .status(400)
        .json({ success: false, message: "Zaten doğrulanmış" });
    }

    if (String(user.gender || "") !== "female") {
      return res.status(403).json({
        success: false,
        message: "Bu doğrulama akışı yalnızca kadın kullanıcılar içindir",
      });
    }

    // Profil fotosu kontrol et
    if (!String(user.profileImage || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Önce profil fotoğrafı yüklemelisiniz",
      });
    }

    // Bekleyen talep var mı?
    if (user.verificationStatus === "pending") {
      return res.status(400).json({
        success: false,
        message: "Zaten bekleyen bir talebiniz var. Lütfen sonucu bekleyin.",
      });
    }

    const files = req.files || {};
    const centerFile = files.faceCenter?.[0] || req.file;
    const leftFile = files.faceLeft?.[0] || null;
    const rightFile = files.faceRight?.[0] || null;

    // 3 selfie fotoğrafı gerekli
    if (!centerFile || !leftFile || !rightFile) {
      return res.status(400).json({
        success: false,
        message:
          "Ön, sol ve sağ yüz fotoğraflarının hepsi gerekli (kameradan çekilmiş olmalı)",
      });
    }

    // Upload et
    const faceCenterUpload = await saveVerificationUpload(
      userId,
      centerFile,
      "center",
    );
    const uploaded = [faceCenterUpload];
    let faceLeftUpload;
    let faceRightUpload;
    try {
      faceLeftUpload = await saveVerificationUpload(userId, leftFile, "left");
      uploaded.push(faceLeftUpload);
      faceRightUpload = await saveVerificationUpload(
        userId,
        rightFile,
        "right",
      );
      uploaded.push(faceRightUpload);
    } catch (uploadErr) {
      await cleanupUploads(uploaded);
      throw uploadErr;
    }

    const submittedAt = new Date();

    // Verification kaydı oluştur
    const verification = await Verification.create({
      user: userId,
      status: "pending",
      selfieUrl: faceCenterUpload.url,
      selfiePublicId: faceCenterUpload.publicId,
      faceCenterUrl: faceCenterUpload.url,
      faceCenterPublicId: faceCenterUpload.publicId,
      faceLeftUrl: faceLeftUpload.url,
      faceLeftPublicId: faceLeftUpload.publicId,
      faceRightUrl: faceRightUpload.url,
      faceRightPublicId: faceRightUpload.publicId,
      profileImageUrl: user.profileImage,
    });

    // Kullanıcı durumunu güncelle
    await User.findByIdAndUpdate(userId, {
      $set: {
        verificationStatus: "pending",
        verificationPhoto: faceCenterUpload.url,
        verificationRequestedAt: submittedAt,
        verificationReviewedAt: null,
        verificationReviewedBy: null,
      },
    });

    logger.info("Verification request submitted", {
      userId,
      verificationId: verification._id,
    });

    // Fire-and-forget: notify admin via Telegram
    const displayName = user.name || user.username || userId.toString();
    notifyAdminTelegram(
      `🔔 <b>Yeni Doğrulama Talebi</b>\n` +
        `👤 Kullanıcı: ${displayName}\n` +
        `🆔 ID: ${userId}\n` +
        `🕐 ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`,
    ).catch(() => {});

    return res.json({
      success: true,
      message:
        "Doğrulama talebi gönderildi. Lütfen onay için 1-30 dakika bekleyin.",
      verificationId: verification._id,
      status: "pending",
    });
  } catch (err) {
    logger.error("uploadFacePhotos error:", err);
    return res.status(500).json({
      success: false,
      message: "Yüz fotoğrafları yüklemesi başarısız",
    });
  }
};

// POST /api/verification/request - Doğrulama talebi (ESKI - backward compat)
exports.requestVerification = async (req, res) => {
  try {
    const userId = req.user.id;

    // Zaten doğrulanmış mı?
    const user = await User.findById(userId).select(
      "isVerified verificationStatus gender profileImage",
    );
    if (user.isVerified) {
      return res
        .status(400)
        .json({ success: false, message: "Zaten doğrulanmış" });
    }

    if (String(user.gender || "") !== "female") {
      return res.status(403).json({
        success: false,
        message: "Bu doğrulama akışı yalnızca kadın kullanıcılar içindir",
      });
    }

    // Bekleyen talep var mı?
    if (user.verificationStatus === "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Zaten bekleyen bir talebiniz var" });
    }

    if (!String(user.profileImage || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Önce profil fotoğrafı yüklemelisiniz",
      });
    }

    const files = req.files || {};
    const centerFile = files.faceCenter?.[0] || files.selfie?.[0] || req.file;
    const leftFile = files.faceLeft?.[0] || null;
    const rightFile = files.faceRight?.[0] || null;

    // Selfie fotoğrafları gerekli (orta + sol + sağ)
    if (!centerFile || !leftFile || !rightFile) {
      return res.status(400).json({
        success: false,
        message: "Orta, sol ve sağ yüz selfie fotoğrafları gerekli",
      });
    }

    const faceCenterUpload = await saveVerificationUpload(
      userId,
      centerFile,
      "center",
    );
    const uploaded = [faceCenterUpload];
    let faceLeftUpload;
    let faceRightUpload;
    try {
      faceLeftUpload = await saveVerificationUpload(userId, leftFile, "left");
      uploaded.push(faceLeftUpload);
      faceRightUpload = await saveVerificationUpload(
        userId,
        rightFile,
        "right",
      );
      uploaded.push(faceRightUpload);
    } catch (uploadErr) {
      await cleanupUploads(uploaded);
      throw uploadErr;
    }

    let verification;
    try {
      verification = await Verification.create({
        user: userId,
        selfieUrl: faceCenterUpload.url,
        faceCenterUrl: faceCenterUpload.url,
        faceLeftUrl: faceLeftUpload.url,
        faceRightUrl: faceRightUpload.url,
      });
    } catch (dbErr) {
      await cleanupUploads(uploaded);
      throw dbErr;
    }

    // User durumunu güncelle
    await User.findByIdAndUpdate(userId, {
      $set: {
        verificationStatus: "pending",
        verificationPhoto: faceCenterUpload.url,
        verificationRequestedAt: new Date(),
      },
    });

    res.json({
      success: true,
      message:
        "Doğrulama talebi gönderildi. Yaklaşık 20 dakika içinde değerlendirilecektir.",
      verification: {
        _id: verification._id,
        status: "pending",
        createdAt: verification.createdAt,
      },
    });
  } catch (err) {
    logger.error("requestVerification error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/verification/status - Doğrulama durumu
exports.getVerificationStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select(
      "isVerified verificationStatus verificationRequestedAt verificationReviewedAt",
    );

    res.json({
      success: true,
      isVerified: user.isVerified,
      status: user.verificationStatus || "none",
      requestedAt: user.verificationRequestedAt,
      reviewedAt: user.verificationReviewedAt,
    });
  } catch (err) {
    logger.error("getVerificationStatus error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ADMIN ENDPOINT'LERİ
// =============================================

// GET /api/verification/admin/pending - Bekleyen talepler
exports.adminGetPending = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20"), 1), 100);

    const total = await Verification.countDocuments({ status: "pending" });
    const verifications = await Verification.find({ status: "pending" })
      .populate(
        "user",
        "_id username name email phone profileImage gender age country broadcasterOnboarding broadcasterContract preferredWithdrawMethod iban bankName paparaId paparaName paypalEmail cryptoAddress cryptoNetwork wiseEmail wiseName",
      )
      .sort({ createdAt: 1 }) // En eski önce
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      verifications,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("adminGetPending error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/verification/admin/all - Tüm talepler
exports.adminGetAll = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20"), 1), 100);
    const status = req.query.status;

    const query = {};
    if (status) query.status = status;

    const total = await Verification.countDocuments(query);
    const verifications = await Verification.find(query)
      .populate(
        "user",
        "_id username name email phone profileImage gender age country broadcasterOnboarding broadcasterContract preferredWithdrawMethod iban bankName paparaId paparaName paypalEmail cryptoAddress cryptoNetwork wiseEmail wiseName",
      )
      .populate("reviewedBy", "_id username name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      verifications,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("adminGetAll error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/verification/admin/:verificationId/approve - Onayla
exports.adminApprove = async (req, res) => {
  try {
    const { verificationId } = req.params;
    const adminId = req.user.id;

    const verification = await Verification.findById(verificationId);
    if (!verification) {
      return res
        .status(404)
        .json({ success: false, message: "Talep bulunamadı" });
    }

    if (verification.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Bu talep zaten incelenmiş" });
    }

    // Verification güncelle
    await Verification.findByIdAndUpdate(verificationId, {
      $set: {
        status: "approved",
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });

    // User güncelle
    await User.findByIdAndUpdate(verification.user, {
      $set: {
        isVerified: true,
        verificationStatus: "approved",
        verificationReviewedAt: new Date(),
        verificationReviewedBy: adminId,
      },
    });

    // Başarım kontrolü
    await checkVerificationAchievement(String(verification.user));

    // Bildirim gönder
    await createNotification({
      recipientId: verification.user,
      type: "verification",
      title: "Profiliniz Doğrulandı! ✅",
      titleEn: "Profile Verified! ✅",
      body: "Tebrikler! Profiliniz başarıyla doğrulandı.",
      bodyEn: "Congratulations! Your profile has been verified.",
    });

    res.json({ success: true, message: "Doğrulama onaylandı" });
  } catch (err) {
    logger.error("adminApprove error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/verification/admin/:verificationId/reject - Reddet
exports.adminReject = async (req, res) => {
  try {
    const { verificationId } = req.params;
    const adminId = req.user.id;
    const { reason } = req.body;

    const verification = await Verification.findById(verificationId);
    if (!verification) {
      return res
        .status(404)
        .json({ success: false, message: "Talep bulunamadı" });
    }

    if (verification.status !== "pending") {
      return res
        .status(400)
        .json({ success: false, message: "Bu talep zaten incelenmiş" });
    }

    await Verification.findByIdAndUpdate(verificationId, {
      $set: {
        status: "rejected",
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectionReason: reason || "Uygun bulunmadı",
      },
    });

    await User.findByIdAndUpdate(verification.user, {
      $set: {
        verificationStatus: "rejected",
        verificationReviewedAt: new Date(),
        verificationReviewedBy: adminId,
      },
    });

    await createNotification({
      recipientId: verification.user,
      type: "verification",
      title: "Doğrulama Talebi Reddedildi",
      titleEn: "Verification Rejected",
      body:
        reason || "Doğrulama talebiniz reddedildi. Tekrar deneyebilirsiniz.",
      bodyEn:
        reason || "Your verification request was rejected. You can try again.",
    });

    res.json({ success: true, message: "Doğrulama reddedildi" });
  } catch (err) {
    logger.error("adminReject error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

/**
 * Admin: Telegram bot bağlantısını test eder.
 * GET /api/verification/admin/test-telegram
 */
exports.testTelegramNotification = async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(503).json({
      success: false,
      message: "TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID env değişkeni eksik",
      configured: { token: !!token, chatId: !!chatId },
    });
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: `✅ <b>Telegram Test Başarılı</b>\n🕐 ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`,
        parse_mode: "HTML",
      },
      { timeout: 8000 },
    );
    return res.json({ success: true, message: "Telegram mesajı gönderildi" });
  } catch (err) {
    return res.status(502).json({
      success: false,
      message: "Telegram API hatası",
      detail: err.response?.data?.description || err.message,
    });
  }
};
