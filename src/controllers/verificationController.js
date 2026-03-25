// src/controllers/verificationController.js
const Verification = require("../models/Verification");
const User = require("../models/User");
const { createNotification } = require("./notificationController");
const { checkVerificationAchievement } = require("./achievementController");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const saveVerificationUpload = (userId, file, suffix) => {
  const fileName = `verify_${userId}_${suffix}_${crypto.randomBytes(16).toString("hex")}${path.extname(file.originalname || ".jpg")}`;
  const uploadDir = path.join(__dirname, "../../uploads/verification");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const filePath = path.join(uploadDir, fileName);
  fs.writeFileSync(filePath, file.buffer);
  return `/uploads/verification/${fileName}`;
};

// =============================================
// KULLANICI ENDPOINT'LERİ
// =============================================

// POST /api/verification/request - Doğrulama talebi
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
      return res
        .status(403)
        .json({
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
      return res
        .status(400)
        .json({
          success: false,
          message: "Önce profil fotoğrafı yüklemelisiniz",
        });
    }

    const files = req.files || {};
    const centerFile = files.faceCenter?.[0] || req.file;
    const leftFile = files.faceLeft?.[0] || null;
    const rightFile = files.faceRight?.[0] || null;

    // Selfie fotoğrafları gerekli
    if (!centerFile || !leftFile || !rightFile) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Orta, sol ve sağ yüz selfie fotoğrafları gerekli",
        });
    }

    const faceCenterUrl = saveVerificationUpload(userId, centerFile, "center");
    const faceLeftUrl = saveVerificationUpload(userId, leftFile, "left");
    const faceRightUrl = saveVerificationUpload(userId, rightFile, "right");

    // Verification kaydı oluştur
    const verification = await Verification.create({
      user: userId,
      selfieUrl: faceCenterUrl,
      faceCenterUrl,
      faceLeftUrl,
      faceRightUrl,
    });

    // User durumunu güncelle
    await User.findByIdAndUpdate(userId, {
      $set: {
        verificationStatus: "pending",
        verificationPhoto: faceCenterUrl,
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
    console.error("requestVerification error:", err);
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
    console.error("getVerificationStatus error:", err);
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
        "_id username name email profileImage gender age country",
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
    console.error("adminGetPending error:", err);
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
        "_id username name email profileImage gender age country",
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
    console.error("adminGetAll error:", err);
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
    console.error("adminApprove error:", err);
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
    console.error("adminReject error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
