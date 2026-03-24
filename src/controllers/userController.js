// src/controllers/userController.js
const { sendError } = require("../utils/response");
const mongoose = require("mongoose");
const User = require("../models/User");
const LiveStream = require("../models/LiveStream");
const Follow = require("../models/Follow");
const Visitor = require("../models/Visitor");
const CallHistory = require("../models/CallHistory");
const path = require("path");
const fs = require("fs");
const {
  normalizeGender,
  genderVisibilityQueryForViewer,
} = require("../utils/gender");
const presenceService = require("../services/presenceService");
const { trackMissionProgress } = require("./missionController");
const { checkFollowerAchievements } = require("./achievementController");
const { createNotification } = require("./notificationController");
const { logger } = require("../utils/logger");
const adminSocket = require("../socket/adminNamespace");

let _followIndexesSynced = false;
const ensureFollowIndexes = async (force = false) => {
  if (_followIndexesSynced && !force) return;
  try {
    await Follow.syncIndexes();
    _followIndexesSynced = true;
  } catch (e) {
    console.warn("âš ï¸ Follow.syncIndexes warning:", e?.message || e);
  }
};

const normalizePresenceStatus = (presenceData = {}) => {
  const raw = String(presenceData.status || "")
    .trim()
    .toLowerCase();
  if (
    raw === "online" ||
    raw === "offline" ||
    raw === "live" ||
    raw === "in_call"
  ) {
    return raw;
  }

  // Backward compatible mapping
  if (presenceData.online === true) {
    if (presenceData.live === true) return "live";
    if (presenceData.inCall === true || presenceData.busy === true)
      return "in_call";
    return "online";
  }

  return "offline";
};

// =============================================
// PROFESSIONAL USER FORMATTER
// =============================================

/**
 * KullanÄ±cÄ± nesnesini format et
 * Presence bilgisi Socket heartbeat (memory) ile okunur
 * âš ï¸ NOT: MongoDB fallback KALDIRILDI - Socket baÄŸlÄ± olmayan kullanÄ±cÄ± OFFLINE'dÄ±r
 */
const formatUser = (user, presenceData = {}) => {
  // âœ… Socket-driven presence: SINGLE SOURCE OF TRUTH
  // presenceData.online = true ise kullanÄ±cÄ± gerÃ§ekten socket'e baÄŸlÄ± demektir
  // MongoDB'deki isOnline deÄŸeri eski/stale olabilir, KULLANILMAZ
  const presenceStatus = normalizePresenceStatus(presenceData);

  const isOnline = presenceStatus !== "offline";
  const isLive = presenceStatus === "live";
  const isBusy = presenceStatus === "in_call";
  const lastSeen =
    presenceData.lastSeen || user.lastSeen || user.lastOnlineAt || null;

  return {
    _id: user._id,
    username: user.username,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage || "",
    gender: user.gender || "other",
    age: user.age || 20,
    location: user.location || "TR",
    country: user.country || "TR",
    followers: user.followers || 0,
    following: user.following || 0,
    gifts: user.gifts || 0,
    coins: user.coins || 0,
    level: user.level || 1,
    totalEarnings: user.totalEarnings || 0,
    role: user.role || "viewer",
    isBanned: user.isBanned || false,
    isVerified: user.isVerified || false,
    // Presence bilgisi: Socket heartbeat (memory) + Mongo fallback
    presenceStatus,
    isLive,
    isBusy,
    isOnline,
    lastSeen,
    authProvider: user.authProvider || "email",
    createdAt: user.createdAt,
  };
};

// =============================================
// MEVCUT ENDPOINT'LER
// =============================================

// Helper function to escape regex special characters
const escapeRegex = (str) => {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

exports.getUsers = async (req, res) => {
  try {
    const currentUserId = req.user?.id ? String(req.user.id) : null;
    const searchQuery = req.query.search
      ? String(req.query.search).trim()
      : null;
    logger.debug("getUsers", { currentUserId, searchQuery });

    // âœ… Query: banned olmayan, kendisi hariÃ§
    const query = {
      isBanned: { $ne: true },
      isActive: { $ne: false },
    };

    // âœ… Kendisini hariÃ§ tut (ObjectId olarak)
    if (currentUserId) {
      try {
        query._id = { $ne: new mongoose.Types.ObjectId(currentUserId) };
        logger.debug("Excluding user", { currentUserId });
      } catch (e) {
        logger.warn("Invalid ObjectId in getUsers", { currentUserId });
      }
    }

    // âœ… Arama filtresi - REGEX INJECTION + ReDoS PROTECTED
    if (searchQuery) {
      const trimmedQuery = searchQuery.substring(0, 100); // Max 100 karakter (ReDoS korumasÄ±)
      const escapedQuery = escapeRegex(trimmedQuery);
      query.$or = [
        { username: { $regex: escapedQuery, $options: "i" } },
        { name: { $regex: escapedQuery, $options: "i" } },
      ];
    }

    // âœ… Cinsiyet filtreleme
    if (currentUserId) {
      const currentUser = await User.findById(currentUserId).select("gender");
      logger.debug("Gender filter", { gender: currentUser?.gender });
      query.gender = genderVisibilityQueryForViewer(currentUser?.gender);
    } else {
      logger.debug("Unauthenticated user - showing only female");
      query.gender = genderVisibilityQueryForViewer(null);
    }

    // âœ… KullanÄ±cÄ± listesi getir
    const users = await User.find(query)
      .select("-password -refreshToken")
      .sort({ createdAt: -1 })
      .lean();

    // âœ… Presence: in-memory (socket) snapshot
    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    // âœ… KullanÄ±cÄ±larÄ± format et ve sÄ±rala
    const formattedUsers = users
      .map((user) => {
        const presenceData = presenceMap[String(user._id)] || {
          online: false,
          busy: false,
          live: false,
          inCall: false,
          status: "offline",
          lastSeen: null,
        };

        return formatUser(user, presenceData);
      })
      .sort((a, b) => {
        // SÄ±rala: Live > Online > Offline
        const aScore = a.isLive ? 3 : a.isOnline ? 2 : 1;
        const bScore = b.isLive ? 3 : b.isOnline ? 2 : 1;

        if (aScore !== bScore) return bScore - aScore;

        // AynÄ± statÃ¼deyse, en yeni ilk
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    logger.debug("getUsers result", { count: formattedUsers.length });
    res.json({
      success: true,
      users: formattedUsers,
      count: formattedUsers.length,
    });
  } catch (err) {
    logger.error("getUsers error", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// ADMIN: TÃ¼m kullanÄ±cÄ±larÄ± listele (pagination destekli) - panel adminler hariÃ§
exports.getAdminUsers = async (req, res) => {
  try {
    const searchQuery = req.query.search
      ? String(req.query.search).trim()
      : null;
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50"), 1), 200);
    const genderFilter = req.query.gender || null;
    const providerFilter = req.query.authProvider || null;

    // Panel admin rollerini (admin, super_admin, moderator) bu listeden hariç tut
    const query = {
      role: { $nin: ["admin", "super_admin", "moderator"] },
    };

    if (searchQuery) {
      const escapedQuery = escapeRegex(searchQuery);
      const orConditions = [
        { username: { $regex: escapedQuery, $options: "i" } },
        { name: { $regex: escapedQuery, $options: "i" } },
        { email: { $regex: escapedQuery, $options: "i" } },
      ];
      // ObjectId ile de arama yap
      if (/^[0-9a-fA-F]{24}$/.test(searchQuery)) {
        const mongoose = require("mongoose");
        orConditions.push({ _id: new mongoose.Types.ObjectId(searchQuery) });
      }
      query.$or = orConditions;
    }

    // Cinsiyet filtresi
    if (genderFilter && ["male", "female", "other"].includes(genderFilter)) {
      query.gender = genderFilter;
    }

    // Giriş yöntemi filtresi
    if (
      providerFilter &&
      ["email", "google", "apple", "phone", "guest"].includes(providerFilter)
    ) {
      query.authProvider = providerFilter;
    }

    const total = await User.countDocuments(query);

    const users = await User.find(query)
      .select("-password -refreshToken")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    const formattedUsers = users.map((user) => {
      const presenceData = presenceMap[String(user._id)] || {
        online: false,
        busy: false,
        live: false,
        inCall: false,
        status: "offline",
        lastSeen: null,
      };

      return formatUser(user, presenceData);
    });

    res.json({
      success: true,
      users: formattedUsers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error("âŒ getAdminUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// ADMIN: Panel admin kullanÄ±cÄ±larÄ±nÄ± listele (admin, super_admin, moderator)
// ADMIN: Elle kullanici olustur (panelden)
exports.adminCreateUser = async (req, res) => {
  try {
    const { username, name, email, password, gender, country, coins } =
      req.body;

    if (!username || !name || !email || !password) {
      return sendError(
        res,
        400,
        "username, name, email ve password zorunludur",
      );
    }

    const trimmedUsername = String(username).trim();
    const trimmedEmail = String(email).trim().toLowerCase();

    if (trimmedUsername.length < 3 || trimmedUsername.length > 30) {
      return sendError(res, 400, "Kullanici adi 3-30 karakter arasi olmali");
    }
    if (String(password).length < 6) {
      return sendError(res, 400, "Sifre en az 6 karakter olmali");
    }

    const existing = await User.findOne({
      $or: [{ username: trimmedUsername }, { email: trimmedEmail }],
    }).lean();
    if (existing) {
      const field =
        existing.username === trimmedUsername ? "Kullanici adi" : "E-posta";
      return sendError(res, 409, `${field} zaten kayitli`);
    }

    const user = await User.create({
      username: trimmedUsername,
      name: String(name).trim(),
      email: trimmedEmail,
      password: String(password),
      gender: normalizeGender(gender) || "other",
      country: country || "TR",
      coins: Number(coins) >= 0 ? Number(coins) : 500,
      isGuest: false,
      isOnline: false,
      lastSeen: new Date(),
    });

    logger.info(
      `Admin ${req.user.id} created user ${user._id} (${user.username})`,
    );

    res.status(201).json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        gender: user.gender,
        country: user.country,
        coins: user.coins,
        level: user.level,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    logger.error("adminCreateUser error:", err);
    sendError(res, 500, "Kullanici olusturulamadi");
  }
};

exports.getPanelAdmins = async (req, res) => {
  try {
    const adminUsers = await User.find({
      role: { $in: ["admin", "super_admin", "moderator"] },
    })
      .select("_id username name email role isOwner isPanelRestricted")
      .sort({ role: 1, username: 1 })
      .lean();

    const userIds = adminUsers.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);
    const hasAdminNamespace =
      typeof adminSocket.getNsp === "function" && Boolean(adminSocket.getNsp());
    const onlineAdminIds =
      hasAdminNamespace &&
      typeof adminSocket.getConnectedAdminIds === "function"
        ? new Set(
            (await adminSocket.getConnectedAdminIds()).map((id) => String(id)),
          )
        : null;

    const formattedAdmins = adminUsers.map((user) => {
      const uid = String(user._id);
      const presenceData = presenceMap[uid] || {
        online: false,
        status: "offline",
      };
      const presenceStatus = normalizePresenceStatus(presenceData);
      const isOnline = onlineAdminIds
        ? onlineAdminIds.has(uid)
        : presenceStatus !== "offline";

      return {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        isOwner: user.isOwner || false,
        isPanelRestricted: user.isPanelRestricted || false,
        isOnline,
      };
    });

    res.json({ success: true, admins: formattedAdmins });
  } catch (err) {
    logger.error("âŒ getPanelAdmins error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// DELETE /api/users/:userId/panel-admin - Panel admin hesabÄ±nÄ± sil (sadece super_admin, patron hariÃ§)
exports.deletePanelAdminUser = async (req, res) => {
  try {
    const requestingUser = await User.findById(req.user.id)
      .select("role isOwner")
      .lean();
    if (!requestingUser) {
      return res
        .status(401)
        .json({ success: false, message: "Yetkilendirme hatasÄ±" });
    }

    // Sadece sÃ¼per admin veya patron kullanabilir
    const isRequesterOwner = requestingUser.isOwner === true;
    const isRequesterSuperAdmin = requestingUser.role === "super_admin";

    if (!isRequesterSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: "Bu iÅŸlem iÃ§in sÃ¼per admin yetkisi gerekli",
      });
    }

    const { userId } = req.params;
    const target = await User.findById(userId).select(
      "role isOwner username email",
    );
    if (!target) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    // Kendini silemez
    if (String(target._id) === String(req.user.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Kendinizi silemezsiniz" });
    }

    // Patron silinemez
    if (target.isOwner === true) {
      return res
        .status(403)
        .json({ success: false, message: "Patron hesabÄ± silinemez" });
    }

    // Patron deÄŸilse sÃ¼per admin hesabÄ±nÄ± silemez
    if (target.role === "super_admin" && !isRequesterOwner) {
      return res
        .status(403)
        .json({ success: false, message: "SÃ¼per admin hesabÄ± silinemez" });
    }

    if (
      target.role !== "admin" &&
      target.role !== "moderator" &&
      target.role !== "super_admin"
    ) {
      return res.status(400).json({
        success: false,
        message: "Sadece panel hesaplarÄ± silinebilir",
      });
    }

    await User.findByIdAndDelete(userId);

    try {
      await LiveStream.deleteMany({ host: userId });
    } catch (e) {}

    logger.info("Panel admin deleted", {
      adminId: req.user.id,
      targetUsername: target.username,
      targetId: userId,
    });

    res.json({
      success: true,
      message: `"${target.username}" panel hesabÄ± silindi`,
    });
  } catch (err) {
    logger.error("deletePanelAdminUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// PATCH /api/users/:userId/restrict-admin - Panel admin kÄ±sÄ±tla/kÄ±sÄ±tÄ± kaldÄ±r
exports.restrictPanelAdmin = async (req, res) => {
  try {
    const requestingUser = await User.findById(req.user.id)
      .select("role isOwner")
      .lean();
    if (!requestingUser) {
      return res
        .status(401)
        .json({ success: false, message: "Yetkilendirme hatasÄ±" });
    }

    const { userId } = req.params;
    const targetUser = await User.findById(userId).select(
      "role isOwner username isPanelRestricted",
    );
    if (!targetUser) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    // Kendini kÄ±sÄ±tlayamazsÄ±n
    if (String(targetUser._id) === String(req.user.id)) {
      return res
        .status(403)
        .json({ success: false, message: "Kendinizi kÄ±sÄ±tlayamazsÄ±nÄ±z" });
    }

    // Owner (patron) hiÃ§bir zaman kÄ±sÄ±tlanamaz
    if (targetUser.isOwner === true) {
      return res
        .status(403)
        .json({ success: false, message: "Patron kÄ±sÄ±tlanamaz" });
    }

    const isRequesterOwner = requestingUser.isOwner === true;
    const isRequesterSuperAdmin = requestingUser.role === "super_admin";

    // Yetki kontrolÃ¼:
    // - Patron: herkesi kÄ±sÄ±tlayabilir (super_admin dahil, kendisi hariÃ§, patron hariÃ§)
    // - Super admin: sadece admin/moderator'Ä± kÄ±sÄ±tlayabilir; diÄŸer super_admin'larÄ± kÄ±sÄ±tlayamaz
    // - Admin/moderator: kimseyi kÄ±sÄ±tlayamaz
    if (!isRequesterOwner && !isRequesterSuperAdmin) {
      return res
        .status(403)
        .json({ success: false, message: "Bu iÅŸlem iÃ§in yetkiniz yok" });
    }

    if (!isRequesterOwner && isRequesterSuperAdmin) {
      if (targetUser.role === "super_admin") {
        return res.status(403).json({
          success: false,
          message: "SÃ¼per adminler birbirini kÄ±sÄ±tlayamaz",
        });
      }
    }

    const { restrict } = req.body; // true = kÄ±sÄ±tla, false = kÄ±sÄ±tÄ± kaldÄ±r
    const newValue = restrict === true || restrict === "true";
    targetUser.isPanelRestricted = newValue;
    await targetUser.save();

    // TokenlarÄ± geÃ§ersiz kÄ±l (kÄ±sÄ±tlanan kullanÄ±cÄ± panelden dÃ¼ÅŸsÃ¼n)
    if (newValue) {
      await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
    }

    res.json({
      success: true,
      message: newValue
        ? `${targetUser.username} panel eriÅŸimi kÄ±sÄ±tlandÄ±`
        : `${targetUser.username} panel eriÅŸimi aÃ§Ä±ldÄ±`,
      isPanelRestricted: newValue,
    });
  } catch (err) {
    logger.error("âŒ restrictPanelAdmin error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

exports.getFemaleUsers = async (req, res) => {
  try {
    const currentUserId = req.user?.id ? String(req.user.id) : null;

    // Cinsiyet görünürlük filtresi: erkek sadece kadınları, kadın herkesi görür
    const baseQuery = {
      isBanned: { $ne: true },
      isActive: { $ne: false },
    };

    if (currentUserId) {
      const currentUser = await User.findById(currentUserId).select("gender");
      baseQuery.gender = genderVisibilityQueryForViewer(currentUser?.gender);
      baseQuery._id = { $ne: new mongoose.Types.ObjectId(currentUserId) };
    } else {
      baseQuery.gender = genderVisibilityQueryForViewer(null);
    }

    const users = await User.find(baseQuery)
      .select("-password -refreshToken")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // âœ… Presence: in-memory (socket) snapshot
    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    // âœ… KullanÄ±cÄ±larÄ± format et ve sÄ±rala
    const formattedUsers = users
      .map((user) => {
        const presenceData = presenceMap[String(user._id)] || {
          online: false,
          busy: false,
          live: false,
          inCall: false,
          status: "offline",
          lastSeen: null,
        };

        return formatUser(user, presenceData);
      })
      .sort((a, b) => {
        // SÄ±rala: Live > Online > Offline
        const aScore = a.isLive ? 3 : a.isOnline ? 2 : 1;
        const bScore = b.isLive ? 3 : b.isOnline ? 2 : 1;

        if (aScore !== bScore) return bScore - aScore;

        // AynÄ± statÃ¼deyse, en yeni ilk
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    logger.debug("getFemaleUsers result", { count: formattedUsers.length });
    res.json({
      success: true,
      users: formattedUsers,
      count: formattedUsers.length,
    });
  } catch (err) {
    logger.error("âŒ getFemaleUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

exports.toggleBan = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return sendError(res, 404, "KullanÄ±cÄ± bulunamadÄ±");

    // Admin kendini banlamasÄ±n
    if (String(user._id) === String(req.user.id)) {
      return sendError(res, 400, "Kendinizi banlayamazsÄ±nÄ±z");
    }

    // Super admin hiÃ§bir zaman banlanamaz
    if (user.role === "super_admin") {
      return sendError(res, 403, "Super admin banlanamaz");
    }

    // Admin sadece super_admin tarafÄ±ndan banlanabilir
    if (user.role === "admin" && req.user.role !== "super_admin") {
      return sendError(
        res,
        403,
        "Admin hesaplar sadece super admin tarafÄ±ndan banlanabilir",
      );
    }

    const newBanState = !user.isBanned;
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { isBanned: newBanState, name: user.name || "User" } },
      { new: true },
    ).select("-password");

    // Notify admin sockets
    adminSocket.emit(newBanState ? "user:banned" : "user:unbanned", {
      userId,
      username: updated.username,
    });

    res.json({
      message: "Ban durumu gÃ¼ncellendi",
      isBanned: updated.isBanned,
    });
  } catch (err) {
    logger.error("toggleBan error:", err);
    sendError(res, 500, "Sunucu hatasÄ±");
  }
};

exports.unbanUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { isBanned: false } },
      { new: true },
    ).select("-password");

    if (!updated) return sendError(res, 404, "KullanÄ±cÄ± yok");

    res.json({ message: "Ban kaldÄ±rÄ±ldÄ±", isBanned: false });
  } catch (err) {
    logger.error("unbanUser error:", err);
    sendError(res, 500, "Sunucu hatasÄ±");
  }
};

// ADMIN: KullanÄ±cÄ±yÄ± kalÄ±cÄ± olarak sil
exports.adminDeleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    // Admin kendini silemesin
    if (String(user._id) === String(req.user.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Kendinizi silemezsiniz" });
    }

    // Super admin hiÃ§bir zaman silinemez
    if (user.role === "super_admin") {
      return res
        .status(403)
        .json({ success: false, message: "Super admin silinemez" });
    }

    // Admin sadece super_admin tarafÄ±ndan silinebilir
    if (user.role === "admin" && req.user.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Admin hesaplar sadece super admin tarafÄ±ndan silinebilir",
      });
    }

    await User.findByIdAndDelete(userId);

    // Ä°liÅŸkili yayÄ±nlarÄ± da temizle
    try {
      await LiveStream.deleteMany({ host: userId });
    } catch (e) {
      console.warn("LiveStream cleanup warning:", e.message);
    }

    logger.info("Admin deleted user", {
      adminId: req.user.id,
      targetUsername: user.username,
      targetId: userId,
    });

    res.json({
      success: true,
      message: `"${user.username}" baÅŸarÄ±yla silindi`,
    });
  } catch (err) {
    logger.error("adminDeleteUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

exports.updateCoins = async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins } = req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { coins } },
      { new: true, runValidators: false },
    ).select("-password");

    if (!user) return sendError(res, 404, "KullanÄ±cÄ± bulunamadÄ±");

    res.json(user);
  } catch (err) {
    logger.error("updateCoins error:", err);
    sendError(res, 500, "Sunucu hatasÄ±");
  }
};

// ADMIN: KullanÄ±cÄ±dan coin Ã§Ä±kar (bakiyesi 0'Ä±n altÄ±na dÃ¼ÅŸmez)
exports.removeCoins = async (req, res) => {
  try {
    const { userId } = req.params;
    const rawAmount = req.body?.amount;
    const amount = Number(rawAmount);

    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "GeÃ§erli bir miktar girin" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    const currentCoins = user.coins || 0;
    const newCoins = Math.max(0, currentCoins - amount);
    const actualRemoved = currentCoins - newCoins;

    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { coins: newCoins } },
      { new: true },
    ).select("-password -refreshToken");

    logger.info("Admin removed coins", {
      adminId: req.user.id,
      targetUsername: user.username,
      removed: actualRemoved,
      newBalance: updated.coins,
    });

    if (global.io && global.userSockets) {
      const targetSockets = global.userSockets.get(String(userId));
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach((socketId) => {
          global.io.to(socketId).emit("coins:updated", {
            coins: updated.coins,
            removed: actualRemoved,
            message: `${actualRemoved} coin hesabÄ±nÄ±zdan Ã§Ä±karÄ±ldÄ±.`,
          });
        });
      }
    }

    res.json({
      success: true,
      message: `${actualRemoved} coin Ã§Ä±karÄ±ldÄ±`,
      coins: updated.coins,
      username: updated.username,
    });
  } catch (err) {
    logger.error("removeCoins error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// ADMIN: KullanÄ±cÄ±ya coin ekle (mevcut bakiyeye ekleme yapar)
exports.addCoins = async (req, res) => {
  try {
    const { userId } = req.params;
    const rawAmount = req.body?.amount;
    const amount = Number(rawAmount);

    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "GeÃ§erli bir miktar girin" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      { $inc: { coins: amount } },
      { new: true },
    ).select("-password -refreshToken");

    logger.info(
      `ğŸ’° Admin ${req.user.id} â†’ ${user.username}'a ${amount} coin ekledi (yeni: ${updated.coins})`,
    );

    // Socket ile kullanÄ±cÄ±ya anlÄ±k bildirim gÃ¶nder
    if (global.io && global.userSockets) {
      const targetKey = String(userId);
      const targetSockets = global.userSockets.get(targetKey);
      if (targetSockets && targetSockets.size > 0) {
        targetSockets.forEach((socketId) => {
          global.io.to(socketId).emit("coins:updated", {
            coins: updated.coins,
            added: amount,
            message: `${amount} coin hesabÄ±nÄ±za eklendi!`,
          });
        });
        logger.info(
          `ğŸ“¡ coins:updated event sent to ${targetSockets.size} socket(s) for user ${userId}`,
        );
      }
    }

    res.json({
      success: true,
      message: `${amount} coin baÅŸarÄ±yla eklendi`,
      coins: updated.coins,
      username: updated.username,
    });
  } catch (err) {
    logger.error("addCoins error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// =============================================
// YENÄ° ENDPOINT'LER - PROFÄ°L EKRANI Ä°Ã‡Ä°N
// =============================================

// GET /api/users/me - Kendi profilini getir
exports.getMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select("-password -refreshToken");

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        preferredLanguage: user.preferredLanguage || "tr",
        profileImage: user.profileImage || "",
        gender: user.gender || "other",
        age: user.age || 0,
        location: user.location || "",
        country: user.country || "TR",
        coins: user.coins || 0,
        level: user.level || 1,
        followers: user.followers || 0,
        following: user.following || 0,
        gifts: user.gifts || 0,
        totalEarnings: user.totalEarnings || 0,
        isOnline: user.isOnline || false,
        isLive: user.isLive || false,
        isVerified: user.isVerified || false,
        createdAt: user.createdAt,
        settings: user.settings || {
          pushNotifications: true,
          emailNotifications: false,
          smsAlerts: false,
          soundEffects: true,
          showOnlineStatus: true,
          profileVisibility: true,
          allowMessages: true,
          showActivity: false,
        },
      },
    });
  } catch (err) {
    logger.error("getMyProfile error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// PUT /api/users/me - Profil gÃ¼ncelle
exports.updateMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name,
      username,
      gender,
      age,
      location,
      country,
      bio,
      preferredLanguage,
    } = req.body;

    // Username benzersizlik kontrolÃ¼
    if (username) {
      const existingUser = await User.findOne({
        username,
        _id: { $ne: userId },
      });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "Bu kullanÄ±cÄ± adÄ± zaten kullanÄ±mda",
        });
      }
    }

    const updateData = {};
    if (name) updateData.name = name;
    if (username) updateData.username = username;
    if (gender !== undefined) updateData.gender = normalizeGender(gender);
    if (age) updateData.age = age;
    if (location) updateData.location = location;
    if (country) updateData.country = country;
    if (bio !== undefined) updateData.bio = bio;
    if (typeof preferredLanguage === "string" && preferredLanguage.trim()) {
      updateData.preferredLanguage = preferredLanguage.trim().toLowerCase();
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true },
    ).select("-password -refreshToken");

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    logger.info(`âœ… Profil gÃ¼ncellendi: ${user.username}`);

    res.json({
      success: true,
      message: "Profil gÃ¼ncellendi",
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        preferredLanguage: user.preferredLanguage || "tr",
        profileImage: user.profileImage || "",
        gender: user.gender,
        age: user.age,
        location: user.location,
        country: user.country,
        bio: user.bio || "",
      },
    });
  } catch (err) {
    logger.error("updateMyProfile error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// POST /api/users/me/avatar - Avatar yÃ¼kle
exports.uploadAvatar = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Dosya yÃ¼klenmedi" });
    }

    const fileName = `avatar_${userId}_${Date.now()}${path.extname(req.file.originalname)}`;
    const uploadDir = path.join(__dirname, "../../uploads/avatars");

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, req.file.buffer);

    const avatarUrl = `/uploads/avatars/${fileName}`;

    // Eski avatarÄ± sil
    const oldUser = await User.findById(userId);
    if (oldUser?.profileImage) {
      const oldPath = path.join(__dirname, "../..", oldUser.profileImage);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { profileImage: avatarUrl } },
      { new: true },
    ).select("-password -refreshToken");

    logger.info(`ğŸ“· Avatar gÃ¼ncellendi: ${user.username}`);

    res.json({
      success: true,
      message: "Avatar gÃ¼ncellendi",
      profileImage: avatarUrl,
    });
  } catch (err) {
    logger.error("uploadAvatar error:", err);
    res.status(500).json({ success: false, message: "Avatar yÃ¼klenemedi" });
  }
};

// DELETE /api/users/me/avatar - Avatar sil
exports.deleteAvatar = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    if (user.profileImage) {
      const filePath = path.join(__dirname, "../..", user.profileImage);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await User.findByIdAndUpdate(userId, { $set: { profileImage: "" } });

    logger.info(`ğŸ—‘ï¸ Avatar silindi: ${user.username}`);

    res.json({ success: true, message: "Avatar silindi" });
  } catch (err) {
    logger.error("deleteAvatar error:", err);
    res.status(500).json({ success: false, message: "Avatar silinemedi" });
  }
};

// GET /api/users/me/stats - Ä°statistikleri getir
exports.getMyStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select(
      "coins level followers following gifts totalEarnings",
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    const stats = {
      coins: user.coins || 0,
      level: user.level || 1,
      followers: user.followers || 0,
      following: user.following || 0,
      gifts: user.gifts || 0,
      totalEarnings: user.totalEarnings || 0,
      streams: 0,
      likes: 0,
      views: 0,
    };

    try {
      const LiveStream = require("../models/LiveStream");
      const streamStats = await LiveStream.aggregate([
        { $match: { hostId: user._id } },
        {
          $group: {
            _id: null,
            totalStreams: { $sum: 1 },
            totalViews: { $sum: "$viewCount" },
            totalLikes: { $sum: "$likeCount" },
          },
        },
      ]);

      if (streamStats.length > 0) {
        stats.streams = streamStats[0].totalStreams || 0;
        stats.views = streamStats[0].totalViews || 0;
        stats.likes = streamStats[0].totalLikes || 0;
      }
    } catch (e) {
      // LiveStream modeli yoksa devam et
    }

    res.json({ success: true, stats });
  } catch (err) {
    logger.error("getMyStats error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// PUT /api/users/me/settings - AyarlarÄ± gÃ¼ncelle
exports.updateSettings = async (req, res) => {
  try {
    const userId = req.user.id;
    const { settings } = req.body;

    if (!settings) {
      return res
        .status(400)
        .json({ success: false, message: "Ayarlar gerekli" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { settings } },
      { new: true },
    ).select("settings");

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    logger.info(`âš™ï¸ Ayarlar gÃ¼ncellendi: ${userId}`);

    res.json({
      success: true,
      message: "Ayarlar gÃ¼ncellendi",
      settings: user.settings,
    });
  } catch (err) {
    logger.error("updateSettings error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// POST /api/users/me/freeze - HesabÄ± dondur
exports.freezeAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { isActive: false, isFrozen: true } },
      { new: true },
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    logger.info(`â„ Hesap donduruldu: ${user.username}`);

    res.json({ success: true, message: "HesabÄ±nÄ±z donduruldu" });
  } catch (err) {
    logger.error("freezeAccount error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// DELETE /api/users/me - HesabÄ± sil
exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (user?.profileImage) {
      const filePath = path.join(__dirname, "../..", user.profileImage);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await User.findByIdAndDelete(userId);

    logger.info(`ğŸ—‘ï¸ Hesap silindi: ${user?.username}`);

    res.json({ success: true, message: "Hesap silindi" });
  } catch (err) {
    logger.error("deleteAccount error:", err);
    res.status(500).json({ success: false, message: "Hesap silinemedi" });
  }
};

// GET /api/users/:userId - BaÅŸka bir kullanÄ±cÄ±nÄ±n profilini getir
exports.getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    let user;

    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await User.findById(userId).select(
        "-password -refreshToken -email",
      );
    } else {
      // Allow username lookup to avoid ObjectId cast errors
      user = await User.findOne({ username: userId }).select(
        "-password -refreshToken -email",
      );
    }

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    const presenceData = await presenceService.getPresence(user._id);
    const presenceStatus = normalizePresenceStatus(presenceData);

    const isLive = presenceStatus === "live";

    res.json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        profileImage: user.profileImage || "",
        gender: user.gender,
        age: user.age,
        location: user.location,
        country: user.country,
        level: user.level || 1,
        followers: user.followers || 0,
        following: user.following || 0,
        gifts: user.gifts || 0,
        coins: user.coins || 0,
        bio: user.bio || "",
        presenceStatus,
        isOnline: presenceStatus !== "offline",
        isLive,
        isVerified: user.isVerified || false,
        lastSeen: presenceData.lastSeen || null,
      },
    });
  } catch (err) {
    logger.error("getUserById error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// =============================================
// YENÄ° ENDPOINT'LER - EKSÄ°K OLANLAR
// =============================================

// POST /api/users/:userId/follow - Takip et
exports.followUser = async (req, res) => {
  try {
    await ensureFollowIndexes();

    const currentUserId = req.user.id;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res
        .status(400)
        .json({ success: false, message: "Kendinizi takip edemezsiniz" });
    }

    const userToFollow = await User.findById(userId);
    if (!userToFollow) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    // Zaten takip ediyor mu kontrol et
    const existing = await Follow.findOne({
      follower: currentUserId,
      following: userId,
    });
    if (existing) {
      return res.json({
        success: true,
        message: "Zaten takip ediyorsunuz",
        isFollowing: true,
      });
    }

    // Follow kaydÄ± oluÅŸtur
    try {
      await Follow.create({ follower: currentUserId, following: userId });
    } catch (createErr) {
      // Duplicate/index race handling
      if (createErr?.code === 11000) {
        const already = await Follow.findOne({
          follower: currentUserId,
          following: userId,
        });

        if (already) {
          // Ä°stek yarÄ±ÅŸÄ±nda baÅŸka bir worker/istek kaydÄ± oluÅŸturduysa idempotent baÅŸarÄ± dÃ¶n
          return res.json({
            success: true,
            message: "Zaten takip ediyorsunuz",
            isFollowing: true,
          });
        }

        // 11000 alÄ±ndÄ± ama kayÄ±t bulunamadÄ±ysa gerÃ§ek index/veri problemi olabilir
        throw createErr;
      } else {
        throw createErr;
      }
    }

    // Counter gÃ¼ncelle
    await User.findByIdAndUpdate(userId, { $inc: { followers: 1 } });
    await User.findByIdAndUpdate(currentUserId, { $inc: { following: 1 } });

    // Achievement & Notification hooks
    const updatedFollowTarget = await User.findById(userId).select(
      "followers username name",
    );
    if (updatedFollowTarget) {
      checkFollowerAchievements(userId, updatedFollowTarget.followers).catch(
        () => {},
      );
    }

    // TakipÃ§iye bildirim gÃ¶nder
    const currentUser = await User.findById(currentUserId).select(
      "username name profileImage",
    );
    createNotification({
      recipientId: userId,
      type: "follow",
      title: "Yeni TakipÃ§i! ğŸ‘‹",
      titleEn: "New Follower! ğŸ‘‹",
      body: `${currentUser?.name || currentUser?.username || "Birisi"} seni takip etmeye baÅŸladÄ±`,
      bodyEn: `${currentUser?.name || currentUser?.username || "Someone"} started following you`,
      senderId: currentUserId,
      relatedId: currentUserId,
      relatedType: "user",
      imageUrl: currentUser?.profileImage,
    }).catch(() => {});

    logger.info(`âœ… ${currentUserId} -> ${userId} takip etti`);

    res.json({ success: true, message: "Takip edildi", isFollowing: true });
  } catch (err) {
    logger.error("followUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// DELETE /api/users/:userId/follow - Takibi bÄ±rak
exports.unfollowUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res.status(400).json({
        success: false,
        message: "Kendinizi takipten Ã§Ä±karamazsÄ±nÄ±z",
      });
    }

    // Follow kaydÄ±nÄ± sil
    const deleted = await Follow.findOneAndDelete({
      follower: currentUserId,
      following: userId,
    });

    if (deleted) {
      // Counter azalt
      await User.findByIdAndUpdate(userId, { $inc: { followers: -1 } });
      await User.findByIdAndUpdate(currentUserId, { $inc: { following: -1 } });

      // Negatif deÄŸerleri dÃ¼zelt
      await User.updateOne(
        { _id: userId, followers: { $lt: 0 } },
        { $set: { followers: 0 } },
      );
      await User.updateOne(
        { _id: currentUserId, following: { $lt: 0 } },
        { $set: { following: 0 } },
      );
    }

    logger.info(`âœ… ${currentUserId} -> ${userId} takipten Ã§Ä±ktÄ±`);

    res.json({
      success: true,
      message: "Takipten Ã§Ä±kÄ±ldÄ±",
      isFollowing: false,
    });
  } catch (err) {
    logger.error("unfollowUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// GET /api/users/me/followers - TakipÃ§ileri getir
exports.getMyFollowers = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const follows = await Follow.find({ following: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate(
        "follower",
        "_id username name profileImage gender age location country level isOnline isLive isBusy presenceStatus followers following",
      );

    const users = follows
      .map((f) => {
        const u = f.follower;
        if (!u) return null;
        return {
          _id: u._id,
          username: u.username,
          name: u.name || u.username,
          profileImage: u.profileImage || "",
          gender: u.gender,
          age: u.age,
          location: u.location,
          country: u.country,
          level: u.level || 1,
          isOnline: u.isOnline || false,
          isLive: u.isLive || false,
          isBusy: u.isBusy || false,
          presenceStatus: u.presenceStatus || "offline",
          followers: u.followers || 0,
          following: u.following || 0,
        };
      })
      .filter(Boolean);

    res.json({ success: true, users });
  } catch (err) {
    logger.error("getMyFollowers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// GET /api/users/me/following - Takip edilenleri getir
exports.getMyFollowing = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const follows = await Follow.find({ follower: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate(
        "following",
        "_id username name profileImage gender age location country level isOnline isLive isBusy presenceStatus followers following",
      );

    const users = follows
      .map((f) => {
        const u = f.following;
        if (!u) return null;
        return {
          _id: u._id,
          username: u.username,
          name: u.name || u.username,
          profileImage: u.profileImage || "",
          gender: u.gender,
          age: u.age,
          location: u.location,
          country: u.country,
          level: u.level || 1,
          isOnline: u.isOnline || false,
          isLive: u.isLive || false,
          isBusy: u.isBusy || false,
          presenceStatus: u.presenceStatus || "offline",
          followers: u.followers || 0,
          following: u.following || 0,
        };
      })
      .filter(Boolean);

    res.json({ success: true, users });
  } catch (err) {
    logger.error("getMyFollowing error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// POST /api/users/:userId/visit - Profil ziyareti kaydet
exports.visitProfile = async (req, res) => {
  try {
    const visitorId = req.user.id;
    const { userId } = req.params;

    // Kendi profilini ziyaret etme
    if (visitorId === userId) {
      return res.json({ success: true, message: "Kendi profiliniz" });
    }

    // Upsert: varsa gÃ¼ncelle, yoksa oluÅŸtur
    await Visitor.findOneAndUpdate(
      { profileOwner: userId, visitor: visitorId },
      { $set: { lastVisitAt: new Date() }, $inc: { visitCount: 1 } },
      { upsert: true, new: true },
    );

    res.json({ success: true, message: "Ziyaret kaydedildi" });
  } catch (err) {
    logger.error("visitProfile error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// GET /api/users/me/visitors - Son ziyaretÃ§ileri getir
exports.getMyVisitors = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const visitors = await Visitor.find({ profileOwner: userId })
      .sort({ lastVisitAt: -1 })
      .limit(limit)
      .populate(
        "visitor",
        "_id username name profileImage gender age location country level isOnline isLive isBusy presenceStatus followers following",
      );

    const result = visitors
      .map((v) => {
        const u = v.visitor;
        if (!u) return null;
        return {
          id: v._id,
          user: {
            _id: u._id,
            username: u.username,
            name: u.name || u.username,
            profileImage: u.profileImage || "",
            gender: u.gender,
            age: u.age,
            location: u.location,
            country: u.country,
            level: u.level || 1,
            isOnline: u.isOnline || false,
            isLive: u.isLive || false,
            isBusy: u.isBusy || false,
            presenceStatus: u.presenceStatus || "offline",
            followers: u.followers || 0,
            following: u.following || 0,
          },
          time: v.lastVisitAt,
          visitCount: v.visitCount,
        };
      })
      .filter(Boolean);

    res.json({ success: true, visitors: result });
  } catch (err) {
    logger.error("getMyVisitors error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// GET /api/users/:userId/is-following - Takip durumu kontrol
exports.isFollowing = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    const existing = await Follow.findOne({
      follower: currentUserId,
      following: userId,
    });
    res.json({ success: true, isFollowing: !!existing });
  } catch (err) {
    logger.error("isFollowing error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// PUT /api/users/:userId/visibility - Profil gÃ¶rÃ¼nÃ¼rlÃ¼ÄŸÃ¼ gÃ¼ncelle
exports.updateVisibility = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;
    const { isHidden } = req.body;

    // Sadece kendi visibility'sini deÄŸiÅŸtirebilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { "settings.profileVisibility": !isHidden } },
      { new: true },
    ).select("settings");

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    logger.info(`âœ… ${userId} visibility gÃ¼ncellendi: ${!isHidden}`);

    res.json({
      success: true,
      message: "GÃ¶rÃ¼nÃ¼rlÃ¼k gÃ¼ncellendi",
      isHidden: isHidden,
    });
  } catch (err) {
    logger.error("updateVisibility error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// GET /api/users/vip - VIP kullanÄ±cÄ±larÄ± getir
exports.getVipUsers = async (req, res) => {
  try {
    const currentUserId = req.user?.id ? String(req.user.id) : null;

    // VIP = level >= 5 olan kullanÄ±cÄ±lar
    const query = {
      isBanned: { $ne: true },
      isActive: { $ne: false },
      level: { $gte: 5 },
    };

    if (currentUserId) {
      query._id = { $ne: new mongoose.Types.ObjectId(currentUserId) };
    }

    // Cinsiyet görünürlük filtresi: erkek sadece kadınları, kadın herkesi görür
    if (currentUserId) {
      const currentUser = await User.findById(currentUserId).select("gender");
      query.gender = genderVisibilityQueryForViewer(currentUser?.gender);
    } else {
      query.gender = genderVisibilityQueryForViewer(null);
    }

    const users = await User.find(query)
      .select("-password -refreshToken")
      .sort({ level: -1, createdAt: -1 })
      .limit(10)
      .lean();

    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    const formattedUsers = users.map((user) => {
      const presenceData = presenceMap[String(user._id)] || {
        online: false,
        busy: false,
        live: false,
        inCall: false,
        status: "offline",
        lastSeen: null,
      };
      return formatUser(user, presenceData);
    });

    logger.info(`âœ… getVipUsers: ${formattedUsers.length} users`);
    res.json({
      success: true,
      users: formattedUsers,
      count: formattedUsers.length,
    });
  } catch (err) {
    logger.error("getVipUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// POST /api/users/:userId/start-broadcast - YayÄ±n baÅŸlat
exports.startBroadcast = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;
    const { title, category } = req.body;

    // Sadece kendisi yayÄ±n baÅŸlatabilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    // Sadece kadÄ±n kullanÄ±cÄ±lar yayÄ±n yapabilir
    if (user.gender !== "female") {
      return res.status(403).json({
        success: false,
        message: "Sadece kadÄ±n kullanÄ±cÄ±lar yayÄ±n yapabilir",
      });
    }

    // âœ… Presence is socket-driven: require an active presence record
    // to prevent marking offline users as LIVE in the database.
    const currentPresence = await presenceService.getPresence(userId);
    if (!currentPresence?.online) {
      return res.status(409).json({
        success: false,
        message:
          "YayÄ±n baÅŸlatmak iÃ§in online (socket baÄŸlÄ±) olmalÄ±sÄ±nÄ±z",
      });
    }

    // User'Ä± live olarak iÅŸaretle
    await User.findByIdAndUpdate(userId, {
      $set: {
        isLive: true,
        presenceStatus: "live",
      },
    });

    // Presence service'i gÃ¼ncelle
    await presenceService.setLive(userId, true);

    logger.info(`ğŸ¬ ${user.username} yayÄ±n baÅŸlattÄ±: ${title}`);

    res.json({
      success: true,
      message: "YayÄ±n baÅŸlatÄ±ldÄ±",
      broadcast: {
        userId: userId,
        title: title || "CanlÄ± YayÄ±n",
        category: category || "Genel",
        startedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error("startBroadcast error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// POST /api/users/:userId/end-broadcast - YayÄ±n sonlandÄ±r
exports.endBroadcast = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    // Sadece kendisi yayÄ±nÄ± sonlandÄ±rabilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "KullanÄ±cÄ± bulunamadÄ±" });
    }

    // User'Ä± offline olarak iÅŸaretle (yayÄ±n bitti = online)
    await User.findByIdAndUpdate(userId, {
      $set: {
        isLive: false,
        presenceStatus: "online",
      },
    });

    // Presence service'i gÃ¼ncelle
    await presenceService.setLive(userId, false);

    logger.info(`ğŸ”´ ${user.username} yayÄ±nÄ± sonlandÄ±rdÄ±`);

    res.json({
      success: true,
      message: "YayÄ±n sonlandÄ±rÄ±ldÄ±",
    });
  } catch (err) {
    logger.error("endBroadcast error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// PUT /api/users/:userId/status - KullanÄ±cÄ± durumu gÃ¼ncelle
exports.updateUserStatus = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;
    const { isOnline } = req.body;

    // Sadece kendisi durumunu gÃ¼ncelleyebilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const updateData = {
      isOnline: isOnline,
      presenceStatus: isOnline ? "online" : "offline",
      lastSeen: new Date(),
    };

    if (isOnline) {
      updateData.lastOnlineAt = new Date();
    } else {
      updateData.lastOfflineAt = new Date();
    }

    await User.findByIdAndUpdate(userId, { $set: updateData });

    // NOT: Presence service'i HTTP'den gÃ¼ncellemiyoruz!
    // GerÃ§ek online/offline durumu socket connection'dan gelir.
    // Bu endpoint sadece DB'yi gÃ¼nceller (Ã¶rn: visibility ayarlarÄ± iÃ§in).
    // Socket baÄŸlantÄ±sÄ± olmadan kullanÄ±cÄ± zaten gerÃ§ekten online olamaz.

    res.json({
      success: true,
      message: `Durum gÃ¼ncellendi: ${isOnline ? "online" : "offline"}`,
    });
  } catch (err) {
    logger.error("updateUserStatus error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasÄ±" });
  }
};

// PUT /api/users/me/email - E-posta değiştir
exports.changeEmail = async (req, res) => {
  try {
    const { email } = req.body;
    const newEmail = String(email || "")
      .trim()
      .toLowerCase();

    if (!newEmail || !newEmail.includes("@")) {
      return res
        .status(400)
        .json({ success: false, message: "Geçerli bir e-posta adresi girin" });
    }

    // Aynı e-posta zaten kullanılıyor mu?
    const existing = await User.findOne({
      email: newEmail,
      _id: { $ne: req.user.id },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Bu e-posta adresi zaten kullanılıyor",
      });
    }

    await User.findByIdAndUpdate(req.user.id, { $set: { email: newEmail } });

    res.json({ success: true, message: "E-posta adresi güncellendi" });
  } catch (err) {
    console.error("changeEmail error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/users/me/phone - Telefon numarası değiştir
exports.changePhone = async (req, res) => {
  try {
    const { phone } = req.body;
    const newPhone = String(phone || "").trim();

    if (!newPhone || newPhone.length < 10) {
      return res.status(400).json({
        success: false,
        message: "Geçerli bir telefon numarası girin",
      });
    }

    await User.findByIdAndUpdate(req.user.id, { $set: { phone: newPhone } });

    res.json({ success: true, message: "Telefon numarası güncellendi" });
  } catch (err) {
    console.error("changePhone error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/me/login-history - Giriş geçmişi
exports.getLoginHistory = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("loginHistory");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // En son girişler önce
    const history = (user.loginHistory || []).sort(
      (a, b) => new Date(b.loginAt) - new Date(a.loginAt),
    );

    res.json({ success: true, history });
  } catch (err) {
    console.error("getLoginHistory error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
