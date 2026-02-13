// src/controllers/userController.js
const mongoose = require("mongoose");
const User = require("../models/User");
const LiveStream = require("../models/LiveStream");
const Follow = require("../models/Follow");
const Visitor = require("../models/Visitor");
const CallHistory = require("../models/CallHistory");
const path = require("path");
const fs = require("fs");
const { normalizeGender, genderVisibilityQueryForViewer } = require("../utils/gender");
const presenceService = require("../services/presenceService");
const { trackMissionProgress } = require("./missionController");
const { checkFollowerAchievements } = require("./achievementController");
const { createNotification } = require("./notificationController");

const normalizePresenceStatus = (presenceData = {}) => {
  const raw = String(presenceData.status || '').trim().toLowerCase();
  if (raw === 'online' || raw === 'offline' || raw === 'live' || raw === 'in_call') {
    return raw;
  }

  // Backward compatible mapping
  if (presenceData.online === true) {
    if (presenceData.live === true) return 'live';
    if (presenceData.inCall === true || presenceData.busy === true) return 'in_call';
    return 'online';
  }

  return 'offline';
};

// =============================================
// PROFESSIONAL USER FORMATTER
// =============================================

/**
 * Kullanıcı nesnesini format et
 * Presence bilgisi Socket heartbeat (memory) ile okunur
 * ⚠️ NOT: MongoDB fallback KALDIRILDI - Socket bağlı olmayan kullanıcı OFFLINE'dır
 */
const formatUser = (user, presenceData = {}) => {
  // ✅ Socket-driven presence: SINGLE SOURCE OF TRUTH
  // presenceData.online = true ise kullanıcı gerçekten socket'e bağlı demektir
  // MongoDB'deki isOnline değeri eski/stale olabilir, KULLANILMAZ
  const presenceStatus = normalizePresenceStatus(presenceData);

  const isOnline = presenceStatus !== 'offline';
  const isLive = presenceStatus === 'live';
  const isBusy = presenceStatus === 'in_call';
  const lastSeen = presenceData.lastSeen || user.lastSeen || user.lastOnlineAt || null;

  return {
    _id: user._id,
    username: user.username,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage || '',
    gender: user.gender || 'other',
    age: user.age || 20,
    location: user.location || 'TR',
    country: user.country || 'TR',
    followers: user.followers || 0,
    following: user.following || 0,
    gifts: user.gifts || 0,
    coins: user.coins || 0,
    level: user.level || 1,
    totalEarnings: user.totalEarnings || 0,
    role: user.role || 'viewer',
    isBanned: user.isBanned || false,
    isVerified: user.isVerified || false,
    // Presence bilgisi: Socket heartbeat (memory) + Mongo fallback
    presenceStatus,
    isLive,
    isBusy,
    isOnline,
    lastSeen,
    createdAt: user.createdAt,
  };
};

// =============================================
// MEVCUT ENDPOINT'LER
// =============================================

// Helper function to escape regex special characters
const escapeRegex = (str) => {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

exports.getUsers = async (req, res) => {
  try {
    const currentUserId = req.user?.id ? String(req.user.id) : null;
    const searchQuery = req.query.search ? String(req.query.search).trim() : null;
    console.log(`📡 getUsers çağrısı: currentUserId=${currentUserId || "❌"}, search=${searchQuery || "❌"}`);

    // ✅ Query: banned olmayan, kendisi hariç
    const query = { 
      isBanned: { $ne: true },
      isActive: { $ne: false },
    };
    
    // ✅ Kendisini hariç tut (ObjectId olarak)
    if (currentUserId) {
      try {
        query._id = { $ne: new mongoose.Types.ObjectId(currentUserId) };
        console.log(`🔍 Excluding user ID: ${currentUserId}`);
      } catch (e) {
        console.log(`⚠️ Invalid ObjectId: ${currentUserId}`);
      }
    }

    // ✅ Arama filtresi - REGEX INJECTION PROTECTED
    if (searchQuery) {
      const escapedQuery = escapeRegex(searchQuery);
      query.$or = [
        { username: { $regex: escapedQuery, $options: 'i' } },
        { name: { $regex: escapedQuery, $options: 'i' } }
      ];
    }

    // ✅ Cinsiyet filtreleme
    if (currentUserId) {
      const currentUser = await User.findById(currentUserId).select("gender");
      console.log(`👤 CurrentUser gender: ${currentUser?.gender || 'unknown'}`);
      query.gender = genderVisibilityQueryForViewer(currentUser?.gender);
    } else {
      console.log(`⚠️ Unauthenticated user - showing only female`);
      query.gender = genderVisibilityQueryForViewer(null);
    }

    // ✅ Kullanıcı listesi getir
    const users = await User.find(query)
      .select("-password -refreshToken")
      .sort({ createdAt: -1 })
      .lean();

    // ✅ Presence: in-memory (socket) snapshot
    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    // ✅ Kullanıcıları format et ve sırala
    const formattedUsers = users
      .map(user => {
        const presenceData = presenceMap[String(user._id)] || {
          online: false,
          busy: false,
          live: false,
          inCall: false,
          status: 'offline',
          lastSeen: null,
        };
        
        return formatUser(user, presenceData);
      })
      .sort((a, b) => {
        // Sırala: Live > Online > Offline
        const aScore = a.isLive ? 3 : (a.isOnline ? 2 : 1);
        const bScore = b.isLive ? 3 : (b.isOnline ? 2 : 1);
        
        if (aScore !== bScore) return bScore - aScore;
        
        // Aynı statüdeyse, en yeni ilk
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    console.log(`✅ ${formattedUsers.length} kullanıcı gönderiliyor`);
    res.json({
      success: true,
      users: formattedUsers,
      count: formattedUsers.length
    });

  } catch (err) {
    console.error("❌ getUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// ADMIN: Tüm kullanıcıları listele (pagination destekli)
exports.getAdminUsers = async (req, res) => {
  try {
    const searchQuery = req.query.search ? String(req.query.search).trim() : null;
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50"), 1), 200);

    const query = {};

    if (searchQuery) {
      const escapedQuery = escapeRegex(searchQuery);
      query.$or = [
        { username: { $regex: escapedQuery, $options: 'i' } },
        { name: { $regex: escapedQuery, $options: 'i' } },
        { email: { $regex: escapedQuery, $options: 'i' } },
      ];
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

    const formattedUsers = users.map(user => {
      const presenceData = presenceMap[String(user._id)] || {
        online: false,
        busy: false,
        live: false,
        inCall: false,
        status: 'offline',
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
    console.error("❌ getAdminUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.getFemaleUsers = async (req, res) => {
  try {
    const currentUserId = req.user?.id ? String(req.user.id) : null;

    // ✅ Base query - always get female users
    const baseQuery = { 
      isBanned: { $ne: true },
      isActive: { $ne: false },
      gender: "female"
    };

    if (currentUserId) {
      baseQuery._id = { $ne: new mongoose.Types.ObjectId(currentUserId) };
    }

    const users = await User.find(baseQuery)
      .select("-password -refreshToken")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // ✅ Presence: in-memory (socket) snapshot
    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    // ✅ Kullanıcıları format et ve sırala
    const formattedUsers = users
      .map(user => {
        const presenceData = presenceMap[String(user._id)] || {
          online: false,
          busy: false,
          live: false,
          inCall: false,
          status: 'offline',
          lastSeen: null,
        };
        
        return formatUser(user, presenceData);
      })
      .sort((a, b) => {
        // Sırala: Live > Online > Offline
        const aScore = a.isLive ? 3 : (a.isOnline ? 2 : 1);
        const bScore = b.isLive ? 3 : (b.isOnline ? 2 : 1);
        
        if (aScore !== bScore) return bScore - aScore;
        
        // Aynı statüdeyse, en yeni ilk
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    console.log(`✅ getFemaleUsers: ${formattedUsers.length} users`);
    res.json({
      success: true,
      users: formattedUsers,
      count: formattedUsers.length
    });

  } catch (err) {
    console.error("❌ getFemaleUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }

};

exports.toggleBan = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "Kullanıcı bulunamadı" });

    // Admin kendini banlamasın
    if (String(user._id) === String(req.user.id)) {
      return res.status(400).json({ message: "Kendinizi banlayamazsınız" });
    }

    // Super admin banlanamasın
    if (user.role === "super_admin" || user.role === "admin") {
      return res.status(403).json({ message: "Admin hesaplar banlanamaz" });
    }

    const newBanState = !user.isBanned;
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { isBanned: newBanState, name: user.name || "User" } },
      { new: true }
    ).select("-password");

    res.json({ message: "Ban durumu güncellendi", isBanned: updated.isBanned });
  } catch (err) {
    console.error("toggleBan error:", err);
    res.status(500).json({ message: "Sunucu hatası" });
  }
};

exports.unbanUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { isBanned: false } },
      { new: true }
    ).select("-password");

    if (!updated) return res.status(404).json({ message: "Kullanıcı yok" });

    res.json({ message: "Ban kaldırıldı", isBanned: false });
  } catch (err) {
    console.error("unbanUser error:", err);
    res.status(500).json({ message: "Sunucu hatası" });
  }
};

// ADMIN: Kullanıcıyı kalıcı olarak sil
exports.adminDeleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Admin kendini silemesin
    if (String(user._id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: "Kendinizi silemezsiniz" });
    }

    // Super admin silinemesin
    if (user.role === "super_admin") {
      return res.status(403).json({ success: false, message: "Super admin silinemez" });
    }

    await User.findByIdAndDelete(userId);

    // İlişkili yayınları da temizle
    try {
      await LiveStream.deleteMany({ hostId: userId });
    } catch (e) {
      console.warn("LiveStream cleanup warning:", e.message);
    }

    console.log(`🗑️ Admin ${req.user.id} kullanıcıyı sildi: ${user.username} (${userId})`);

    res.json({
      success: true,
      message: `"${user.username}" başarıyla silindi`,
    });
  } catch (err) {
    console.error("adminDeleteUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.updateCoins = async (req, res) => {
  try {
    const { userId } = req.params;
    const { coins } = req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { coins } },
      { new: true, runValidators: false }
    ).select("-password");

    if (!user) return res.status(404).json({ message: "Kullanıcı bulunamadı" });

    res.json(user);
  } catch (err) {
    console.error("updateCoins error:", err);
    res.status(500).json({ message: "Sunucu hatası" });
  }
};

// ADMIN: Kullanıcıya coin ekle (mevcut bakiyeye ekleme yapar)
exports.addCoins = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount } = req.body;

    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Geçerli bir miktar girin" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      { $inc: { coins: amount } },
      { new: true }
    ).select("-password -refreshToken");

    console.log(`💰 Admin ${req.user.id} → ${user.username}'a ${amount} coin ekledi (yeni: ${updated.coins})`);

    res.json({
      success: true,
      message: `${amount} coin başarıyla eklendi`,
      coins: updated.coins,
      username: updated.username,
    });
  } catch (err) {
    console.error("addCoins error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// YENİ ENDPOINT'LER - PROFİL EKRANI İÇİN
// =============================================

// GET /api/users/me - Kendi profilini getir
exports.getMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
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
          showActivity: false
        }
      }
    });
  } catch (err) {
    console.error("getMyProfile error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/users/me - Profil güncelle
exports.updateMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, username, gender, age, location, country, bio } = req.body;

    // Username benzersizlik kontrolü
    if (username) {
      const existingUser = await User.findOne({
        username,
        _id: { $ne: userId }
      });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "Bu kullanıcı adı zaten kullanımda"
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

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    console.log(`✅ Profil güncellendi: ${user.username}`);

    res.json({
      success: true,
      message: "Profil güncellendi",
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage || "",
        gender: user.gender,
        age: user.age,
        location: user.location,
        country: user.country,
        bio: user.bio || ""
      }
    });
  } catch (err) {
    console.error("updateMyProfile error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/users/me/avatar - Avatar yükle
exports.uploadAvatar = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Dosya yüklenmedi" });
    }

    const fileName = `avatar_${userId}_${Date.now()}${path.extname(req.file.originalname)}`;
    const uploadDir = path.join(__dirname, "../../uploads/avatars");

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, req.file.buffer);

    const avatarUrl = `/uploads/avatars/${fileName}`;

    // Eski avatarı sil
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
      { new: true }
    ).select("-password -refreshToken");

    console.log(`📷 Avatar güncellendi: ${user.username}`);

    res.json({
      success: true,
      message: "Avatar güncellendi",
      profileImage: avatarUrl
    });
  } catch (err) {
    console.error("uploadAvatar error:", err);
    res.status(500).json({ success: false, message: "Avatar yüklenemedi" });
  }
};

// DELETE /api/users/me/avatar - Avatar sil
exports.deleteAvatar = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    if (user.profileImage) {
      const filePath = path.join(__dirname, "../..", user.profileImage);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await User.findByIdAndUpdate(userId, { $set: { profileImage: "" } });

    console.log(`🗑️ Avatar silindi: ${user.username}`);

    res.json({ success: true, message: "Avatar silindi" });
  } catch (err) {
    console.error("deleteAvatar error:", err);
    res.status(500).json({ success: false, message: "Avatar silinemedi" });
  }
};

// GET /api/users/me/stats - İstatistikleri getir
exports.getMyStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select("coins level followers following gifts totalEarnings");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
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
      views: 0
    };

    try {
      const LiveStream = require("../models/LiveStream");
      const streamStats = await LiveStream.aggregate([
        { $match: { hostId: user._id } },
        { $group: {
          _id: null,
          totalStreams: { $sum: 1 },
          totalViews: { $sum: "$viewCount" },
          totalLikes: { $sum: "$likeCount" }
        }}
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
    console.error("getMyStats error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/users/me/settings - Ayarları güncelle
exports.updateSettings = async (req, res) => {
  try {
    const userId = req.user.id;
    const { settings } = req.body;

    if (!settings) {
      return res.status(400).json({ success: false, message: "Ayarlar gerekli" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { settings } },
      { new: true }
    ).select("settings");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    console.log(`⚙️ Ayarlar güncellendi: ${userId}`);

    res.json({ success: true, message: "Ayarlar güncellendi", settings: user.settings });
  } catch (err) {
    console.error("updateSettings error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/users/me/freeze - Hesabı dondur
exports.freezeAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { isActive: false, isFrozen: true } },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    console.log(`❄ Hesap donduruldu: ${user.username}`);

    res.json({ success: true, message: "Hesabınız donduruldu" });
  } catch (err) {
    console.error("freezeAccount error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/users/me - Hesabı sil
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

    console.log(`🗑️ Hesap silindi: ${user?.username}`);

    res.json({ success: true, message: "Hesap silindi" });
  } catch (err) {
    console.error("deleteAccount error:", err);
    res.status(500).json({ success: false, message: "Hesap silinemedi" });
  }
};

// GET /api/users/:userId - Başka bir kullanıcının profilini getir
exports.getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    let user;

    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await User.findById(userId).select("-password -refreshToken -email");
    } else {
      // Allow username lookup to avoid ObjectId cast errors
      user = await User.findOne({ username: userId }).select("-password -refreshToken -email");
    }

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const presenceData = await presenceService.getPresence(user._id);
    const presenceStatus = normalizePresenceStatus(presenceData);

    const isLive = presenceStatus === 'live';

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
        bio: user.bio || "",
        presenceStatus,
        isOnline: presenceStatus !== 'offline',
        isLive,
        isVerified: user.isVerified || false,
        lastSeen: presenceData.lastSeen || null
      }
    });
  } catch (err) {
    console.error("getUserById error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// YENİ ENDPOINT'LER - EKSİK OLANLAR
// =============================================

// POST /api/users/:userId/follow - Takip et
exports.followUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res.status(400).json({ success: false, message: "Kendinizi takip edemezsiniz" });
    }

    const userToFollow = await User.findById(userId);
    if (!userToFollow) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Zaten takip ediyor mu kontrol et
    const existing = await Follow.findOne({ follower: currentUserId, following: userId });
    if (existing) {
      return res.json({ success: true, message: "Zaten takip ediyorsunuz", isFollowing: true });
    }

    // Follow kaydı oluştur
    await Follow.create({ follower: currentUserId, following: userId });

    // Counter güncelle
    await User.findByIdAndUpdate(userId, { $inc: { followers: 1 } });
    await User.findByIdAndUpdate(currentUserId, { $inc: { following: 1 } });

    // Achievement & Notification hooks
    const updatedFollowTarget = await User.findById(userId).select("followers username name");
    if (updatedFollowTarget) {
      checkFollowerAchievements(userId, updatedFollowTarget.followers).catch(() => {});
    }
    
    // Takipçiye bildirim gönder
    const currentUser = await User.findById(currentUserId).select("username name profileImage");
    createNotification({
      recipientId: userId,
      type: "follow",
      title: "Yeni Takipçi! 👋",
      titleEn: "New Follower! 👋",
      body: `${currentUser?.name || currentUser?.username || 'Birisi'} seni takip etmeye başladı`,
      bodyEn: `${currentUser?.name || currentUser?.username || 'Someone'} started following you`,
      senderId: currentUserId,
      relatedId: currentUserId,
      relatedType: "user",
      imageUrl: currentUser?.profileImage,
    }).catch(() => {});

    console.log(`✅ ${currentUserId} -> ${userId} takip etti`);

    res.json({ success: true, message: "Takip edildi", isFollowing: true });
  } catch (err) {
    console.error("followUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/users/:userId/follow - Takibi bırak
exports.unfollowUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res.status(400).json({ success: false, message: "Kendinizi takipten çıkaramazsınız" });
    }

    // Follow kaydını sil
    const deleted = await Follow.findOneAndDelete({ follower: currentUserId, following: userId });

    if (deleted) {
      // Counter azalt
      await User.findByIdAndUpdate(userId, { $inc: { followers: -1 } });
      await User.findByIdAndUpdate(currentUserId, { $inc: { following: -1 } });

      // Negatif değerleri düzelt
      await User.updateOne({ _id: userId, followers: { $lt: 0 } }, { $set: { followers: 0 } });
      await User.updateOne({ _id: currentUserId, following: { $lt: 0 } }, { $set: { following: 0 } });
    }

    console.log(`✅ ${currentUserId} -> ${userId} takipten çıktı`);

    res.json({ success: true, message: "Takipten çıkıldı", isFollowing: false });
  } catch (err) {
    console.error("unfollowUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/me/followers - Takipçileri getir
exports.getMyFollowers = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const follows = await Follow.find({ following: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('follower', '_id username name profileImage gender age location country level isOnline isLive isBusy presenceStatus followers following');

    const users = follows.map(f => {
      const u = f.follower;
      if (!u) return null;
      return {
        _id: u._id,
        username: u.username,
        name: u.name || u.username,
        profileImage: u.profileImage || '',
        gender: u.gender,
        age: u.age,
        location: u.location,
        country: u.country,
        level: u.level || 1,
        isOnline: u.isOnline || false,
        isLive: u.isLive || false,
        isBusy: u.isBusy || false,
        presenceStatus: u.presenceStatus || 'offline',
        followers: u.followers || 0,
        following: u.following || 0,
      };
    }).filter(Boolean);

    res.json({ success: true, users });
  } catch (err) {
    console.error("getMyFollowers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
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
      .populate('following', '_id username name profileImage gender age location country level isOnline isLive isBusy presenceStatus followers following');

    const users = follows.map(f => {
      const u = f.following;
      if (!u) return null;
      return {
        _id: u._id,
        username: u.username,
        name: u.name || u.username,
        profileImage: u.profileImage || '',
        gender: u.gender,
        age: u.age,
        location: u.location,
        country: u.country,
        level: u.level || 1,
        isOnline: u.isOnline || false,
        isLive: u.isLive || false,
        isBusy: u.isBusy || false,
        presenceStatus: u.presenceStatus || 'offline',
        followers: u.followers || 0,
        following: u.following || 0,
      };
    }).filter(Boolean);

    res.json({ success: true, users });
  } catch (err) {
    console.error("getMyFollowing error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
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

    // Upsert: varsa güncelle, yoksa oluştur
    await Visitor.findOneAndUpdate(
      { profileOwner: userId, visitor: visitorId },
      { $set: { lastVisitAt: new Date() }, $inc: { visitCount: 1 } },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: "Ziyaret kaydedildi" });
  } catch (err) {
    console.error("visitProfile error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/me/visitors - Son ziyaretçileri getir
exports.getMyVisitors = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const visitors = await Visitor.find({ profileOwner: userId })
      .sort({ lastVisitAt: -1 })
      .limit(limit)
      .populate('visitor', '_id username name profileImage gender age location country level isOnline isLive isBusy presenceStatus followers following');

    const result = visitors.map(v => {
      const u = v.visitor;
      if (!u) return null;
      return {
        id: v._id,
        user: {
          _id: u._id,
          username: u.username,
          name: u.name || u.username,
          profileImage: u.profileImage || '',
          gender: u.gender,
          age: u.age,
          location: u.location,
          country: u.country,
          level: u.level || 1,
          isOnline: u.isOnline || false,
          isLive: u.isLive || false,
          isBusy: u.isBusy || false,
          presenceStatus: u.presenceStatus || 'offline',
          followers: u.followers || 0,
          following: u.following || 0,
        },
        time: v.lastVisitAt,
        visitCount: v.visitCount,
      };
    }).filter(Boolean);

    res.json({ success: true, visitors: result });
  } catch (err) {
    console.error("getMyVisitors error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/:userId/is-following - Takip durumu kontrol
exports.isFollowing = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    const existing = await Follow.findOne({ follower: currentUserId, following: userId });
    res.json({ success: true, isFollowing: !!existing });
  } catch (err) {
    console.error("isFollowing error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/users/:userId/visibility - Profil görünürlüğü güncelle
exports.updateVisibility = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;
    const { isHidden } = req.body;

    // Sadece kendi visibility'sini değiştirebilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { 'settings.profileVisibility': !isHidden } },
      { new: true }
    ).select("settings");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    console.log(`✅ ${userId} visibility güncellendi: ${!isHidden}`);

    res.json({
      success: true,
      message: "Görünürlük güncellendi",
      isHidden: isHidden
    });
  } catch (err) {
    console.error("updateVisibility error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/vip - VIP kullanıcıları getir
exports.getVipUsers = async (req, res) => {
  try {
    const currentUserId = req.user?.id ? String(req.user.id) : null;

    // VIP = level >= 5 olan kullanıcılar
    const query = {
      isBanned: { $ne: true },
      isActive: { $ne: false },
      level: { $gte: 5 }
    };

    if (currentUserId) {
      query._id = { $ne: new mongoose.Types.ObjectId(currentUserId) };
    }

    const users = await User.find(query)
      .select("-password -refreshToken")
      .sort({ level: -1, createdAt: -1 })
      .limit(10)
      .lean();

    const userIds = users.map((u) => String(u._id));
    const presenceMap = await presenceService.getMultiplePresence(userIds);

    const formattedUsers = users.map(user => {
      const presenceData = presenceMap[String(user._id)] || {
        online: false,
        busy: false,
        live: false,
        inCall: false,
        status: 'offline',
        lastSeen: null,
      };
      return formatUser(user, presenceData);
    });

    console.log(`✅ getVipUsers: ${formattedUsers.length} users`);
    res.json({
      success: true,
      users: formattedUsers,
      count: formattedUsers.length
    });

  } catch (err) {
    console.error("getVipUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/users/:userId/start-broadcast - Yayın başlat
exports.startBroadcast = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;
    const { title, category } = req.body;

    // Sadece kendisi yayın başlatabilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Sadece kadın kullanıcılar yayın yapabilir
    if (user.gender !== 'female') {
      return res.status(403).json({ success: false, message: "Sadece kadın kullanıcılar yayın yapabilir" });
    }

    // ✅ Presence is socket-driven: require an active presence record
    // to prevent marking offline users as LIVE in the database.
    const currentPresence = await presenceService.getPresence(userId);
    if (!currentPresence?.online) {
      return res.status(409).json({
        success: false,
        message: "Yayın başlatmak için online (socket bağlı) olmalısınız",
      });
    }

    // User'ı live olarak işaretle
    await User.findByIdAndUpdate(userId, {
      $set: {
        isLive: true,
        presenceStatus: 'live'
      }
    });

    // Presence service'i güncelle
    await presenceService.setLive(userId, true);

    console.log(`🎬 ${user.username} yayın başlattı: ${title}`);

    res.json({
      success: true,
      message: "Yayın başlatıldı",
      broadcast: {
        userId: userId,
        title: title || "Canlı Yayın",
        category: category || "Genel",
        startedAt: new Date()
      }
    });
  } catch (err) {
    console.error("startBroadcast error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/users/:userId/end-broadcast - Yayın sonlandır
exports.endBroadcast = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    // Sadece kendisi yayını sonlandırabilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // User'ı offline olarak işaretle (yayın bitti = online)
    await User.findByIdAndUpdate(userId, {
      $set: {
        isLive: false,
        presenceStatus: 'online'
      }
    });

    // Presence service'i güncelle
    await presenceService.setLive(userId, false);

    console.log(`🔴 ${user.username} yayını sonlandırdı`);

    res.json({
      success: true,
      message: "Yayın sonlandırıldı"
    });
  } catch (err) {
    console.error("endBroadcast error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/users/:userId/status - Kullanıcı durumu güncelle
exports.updateUserStatus = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;
    const { isOnline } = req.body;

    // Sadece kendisi durumunu güncelleyebilir
    if (currentUserId !== userId) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    const updateData = {
      isOnline: isOnline,
      presenceStatus: isOnline ? 'online' : 'offline',
      lastSeen: new Date()
    };

    if (isOnline) {
      updateData.lastOnlineAt = new Date();
    } else {
      updateData.lastOfflineAt = new Date();
    }

    await User.findByIdAndUpdate(userId, { $set: updateData });

    // NOT: Presence service'i HTTP'den güncellemiyoruz!
    // Gerçek online/offline durumu socket connection'dan gelir.
    // Bu endpoint sadece DB'yi günceller (örn: visibility ayarları için).
    // Socket bağlantısı olmadan kullanıcı zaten gerçekten online olamaz.

    res.json({
      success: true,
      message: `Durum güncellendi: ${isOnline ? 'online' : 'offline'}`
    });
  } catch (err) {
    console.error("updateUserStatus error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
