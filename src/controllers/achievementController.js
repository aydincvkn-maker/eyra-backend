// src/controllers/achievementController.js
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { createNotification } = require("./notificationController");
const { logger } = require("../utils/logger");

// =============================================
// ACHIEVEMENT DEFINITIONS
// =============================================

const ACHIEVEMENTS = [
  // Sosyal
  {
    id: "first_follow",
    name: "İlk Takip",
    nameEn: "First Follow",
    icon: "👋",
    description: "İlk takipçini kazan",
    category: "social",
    condition: { type: "followers", count: 1 },
    rewardCoins: 50,
    rewardXP: 20,
  },
  {
    id: "popular_100",
    name: "Süperstar",
    nameEn: "Superstar",
    icon: "💫",
    description: "100 takipçiye ulaş",
    category: "social",
    condition: { type: "followers", count: 100 },
    rewardCoins: 1000,
    rewardXP: 500,
  },
  {
    id: "popular_500",
    name: "Efsane",
    nameEn: "Legend",
    icon: "👑",
    description: "500 takipçiye ulaş",
    category: "social",
    condition: { type: "followers", count: 500 },
    rewardCoins: 1000,
    rewardXP: 2000,
  },

  // Streaming
  {
    id: "first_stream",
    name: "İlk Yayın",
    nameEn: "First Stream",
    icon: "📺",
    description: "İlk yayınını yap",
    category: "streaming",
    condition: { type: "streams", count: 1 },
    rewardCoins: 100,
    rewardXP: 50,
  },
  {
    id: "streamer_10",
    name: "Yayıncı",
    nameEn: "Streamer",
    icon: "🎤️",
    description: "10 yayın yap",
    category: "streaming",
    condition: { type: "streams", count: 10 },
    rewardCoins: 300,
    rewardXP: 200,
  },
  {
    id: "streamer_50",
    name: "Pro Yayıncı",
    nameEn: "Pro Streamer",
    icon: "🎬",
    description: "50 yayın yap",
    category: "streaming",
    condition: { type: "streams", count: 50 },
    rewardCoins: 2000,
    rewardXP: 1000,
  },

  // Milestones
  {
    id: "coins_10000",
    name: "Milyoner",
    nameEn: "Millionaire",
    icon: "💎",
    description: "10000 coin biriktir",
    category: "milestone",
    condition: { type: "coins", count: 10000 },
    rewardCoins: 0,
    rewardXP: 500,
  },
];

// =============================================
// ACHIEVEMENT CHECK ENGINE
// =============================================

/**
 * Belirli bir achievement'ı kontrol et ve kilidi açılmamışsa aç
 */
const tryUnlockAchievement = async (userId, achievementId) => {
  try {
    // Gender + varlık kontrolü tek sorguda
    const user = await User.findById(userId).select(
      "coins xp level followers gender",
    );
    if (!user) return null;

    // Başarımlar sadece kadın kullanıcılara
    if (user.gender !== "female") return null;

    const achievement = ACHIEVEMENTS.find((a) => a.id === achievementId);
    if (!achievement) return null;

    // Koşul sağlanıyor mu?
    let conditionMet = false;
    switch (achievement.condition.type) {
      case "followers":
        conditionMet = user.followers >= achievement.condition.count;
        break;
      case "level":
        conditionMet = user.level >= achievement.condition.count;
        break;
      case "coins":
        conditionMet = user.coins >= achievement.condition.count;
        break;
      case "verified": {
        const fullUser = await User.findById(userId).select("isVerified");
        conditionMet = fullUser?.isVerified === true;
        break;
      }
      // streams, gifts_sent, gifts_received -> harici kontrol
      default:
        conditionMet = true; // Manuel tetikleme
    }

    if (!conditionMet) return null;

    // Achievement'ı aç
    const achievementEntry = {
      id: achievement.id,
      name: achievement.name,
      icon: achievement.icon,
      description: achievement.description,
      category: achievement.category,
      unlockedAt: new Date(),
    };

    const updateOps = {
      $push: { achievements: achievementEntry },
    };

    if (achievement.rewardCoins > 0 || achievement.rewardXP > 0) {
      updateOps.$inc = {};
      if (achievement.rewardCoins > 0)
        updateOps.$inc.coins = achievement.rewardCoins;
      if (achievement.rewardXP > 0) {
        updateOps.$inc.xp = achievement.rewardXP;
        updateOps.$inc.totalXpEarned = achievement.rewardXP;
      }
    }

    // Atomik yazma: filtre "achievements.id != achievementId" garantisiyle
    // eş zamanlı iki istek aynı başarımı iki kez veremez
    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, "achievements.id": { $ne: achievementId } },
      updateOps,
      { new: true },
    ).select("coins xp level achievements");

    // null → başarım zaten vardı (race condition engellendi)
    if (!updatedUser) return null;

    // Transaction kaydet
    if (achievement.rewardCoins > 0) {
      await Transaction.create({
        user: userId,
        type: "achievement_reward",
        amount: achievement.rewardCoins,
        balanceAfter: updatedUser?.coins || 0,
        description: `Başarım ödülü: ${achievement.name}`,
      });
    }

    // Level check
    if (achievement.rewardXP > 0 && updatedUser) {
      const newLevel = updatedUser.calculateLevel();
      if (newLevel !== updatedUser.level) {
        await User.findByIdAndUpdate(userId, { $set: { level: newLevel } });
        // Level-up başarım kontrolü
        await checkLevelAchievements(userId, newLevel);
      }
    }

    // Bildirim gönder
    await createNotification({
      recipientId: userId,
      type: "achievement",
      title: `Başarım Kazandınız! ${achievement.icon}`,
      titleEn: `Achievement Unlocked! ${achievement.icon}`,
      body: `"${achievement.name}" başarımını kazandınız!`,
      bodyEn: `You unlocked "${achievement.nameEn || achievement.name}"!`,
      actionData: { achievementId: achievement.id },
    });

    return achievementEntry;
  } catch (err) {
    logger.error("tryUnlockAchievement error:", err);
    return null;
  }
};

/**
 * Seviye bazlı başarımları kontrol et
 */
const checkLevelAchievements = async (_userId, _level) => {
  // level_5 ve level_10 kaldırıldı
};
exports.checkLevelAchievements = checkLevelAchievements;

/**
 * Takipçi bazlı başarımları kontrol et
 */
exports.checkFollowerAchievements = async (userId, followerCount) => {
  if (followerCount >= 1) await tryUnlockAchievement(userId, "first_follow");
  if (followerCount >= 100) await tryUnlockAchievement(userId, "popular_100");
  if (followerCount >= 500) await tryUnlockAchievement(userId, "popular_500");
};

/**
 * Hediye gönderme bazlı başarımlar kaldırıldı (kadınlar hediye göndermez)
 */
exports.checkGiftSentAchievements = async (_userId, _totalSent) => {};

/**
 * Hediye alma bazlı başarımları kontrol et
 */
exports.checkGiftReceivedAchievements = async (_userId) => {
  // first_gift_received kaldırıldı
};

/**
 * Yayın bazlı başarımları kontrol et
 */
exports.checkStreamAchievements = async (userId, streamCount) => {
  if (streamCount >= 1) await tryUnlockAchievement(userId, "first_stream");
  if (streamCount >= 10) await tryUnlockAchievement(userId, "streamer_10");
  if (streamCount >= 50) await tryUnlockAchievement(userId, "streamer_50");
};

/**
 * Doğrulama başarımını kontrol et
 */
exports.checkVerificationAchievement = async (_userId) => {
  // verified başarımı kaldırıldı
};

/**
 * coins_1000 kaldırıldı — coins_10000 kaldı
 */
exports.checkCoinAchievements = async (userId, coinBalance) => {
  if (coinBalance >= 10000) await tryUnlockAchievement(userId, "coins_10000");
};

// =============================================
// API ENDPOINTS
// =============================================

// GET /api/achievements - Tüm başarımlar (kullanıcı durumu ile)
exports.getAchievements = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("achievements gender");

    // Başarımlar sadece kadın kullanıcılara
    if (user?.gender !== "female") {
      return res.json({
        success: true,
        achievements: [],
        stats: { total: 0, unlocked: 0, percentage: 0 },
      });
    }
    const unlockedIds = (user?.achievements || []).map((a) => a.id);

    const achievements = ACHIEVEMENTS.map((a) => {
      const unlocked = user?.achievements?.find((ua) => ua.id === a.id);
      return {
        id: a.id,
        name: a.name,
        nameEn: a.nameEn,
        icon: a.icon,
        description: a.description,
        category: a.category,
        rewardCoins: a.rewardCoins,
        rewardXP: a.rewardXP,
        isUnlocked: unlockedIds.includes(a.id),
        unlockedAt: unlocked?.unlockedAt || null,
      };
    });

    const totalUnlocked = achievements.filter((a) => a.isUnlocked).length;

    res.json({
      success: true,
      achievements,
      stats: {
        total: ACHIEVEMENTS.length,
        unlocked: totalUnlocked,
        percentage: Math.round((totalUnlocked / ACHIEVEMENTS.length) * 100),
      },
    });
  } catch (err) {
    logger.error("getAchievements error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/achievements/recent - Son kazanılan başarımlar
exports.getRecentAchievements = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("achievements gender");

    // Başarımlar sadece kadın kullanıcılara
    if (user?.gender !== "female") {
      return res.json({ success: true, achievements: [] });
    }

    const recent = (user?.achievements || [])
      .sort((a, b) => new Date(b.unlockedAt) - new Date(a.unlockedAt))
      .slice(0, 5);

    res.json({ success: true, achievements: recent });
  } catch (err) {
    logger.error("getRecentAchievements error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

module.exports = exports;
