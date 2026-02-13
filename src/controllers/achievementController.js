// src/controllers/achievementController.js
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { createNotification } = require("./notificationController");

// =============================================
// ACHIEVEMENT DEFINITIONS
// =============================================

const ACHIEVEMENTS = [
  // Sosyal
  { id: "first_follow", name: "İlk Takip", nameEn: "First Follow", icon: "👋", description: "İlk takipçini kazan", category: "social", condition: { type: "followers", count: 1 }, rewardCoins: 50, rewardXP: 20 },
  { id: "popular_10", name: "Popüler", nameEn: "Popular", icon: "⭐", description: "10 takipçiye ulaş", category: "social", condition: { type: "followers", count: 10 }, rewardCoins: 200, rewardXP: 100 },
  { id: "popular_50", name: "Yıldız", nameEn: "Star", icon: "🌟", description: "50 takipçiye ulaş", category: "social", condition: { type: "followers", count: 50 }, rewardCoins: 500, rewardXP: 250 },
  { id: "popular_100", name: "Süperstar", nameEn: "Superstar", icon: "💫", description: "100 takipçiye ulaş", category: "social", condition: { type: "followers", count: 100 }, rewardCoins: 1000, rewardXP: 500 },
  { id: "popular_500", name: "Efsane", nameEn: "Legend", icon: "👑", description: "500 takipçiye ulaş", category: "social", condition: { type: "followers", count: 500 }, rewardCoins: 5000, rewardXP: 2000 },
  
  // Streaming
  { id: "first_stream", name: "İlk Yayın", nameEn: "First Stream", icon: "📺", description: "İlk yayınını yap", category: "streaming", condition: { type: "streams", count: 1 }, rewardCoins: 100, rewardXP: 50 },
  { id: "streamer_10", name: "Yayıncı", nameEn: "Streamer", icon: "🎙️", description: "10 yayın yap", category: "streaming", condition: { type: "streams", count: 10 }, rewardCoins: 500, rewardXP: 200 },
  { id: "streamer_50", name: "Pro Yayıncı", nameEn: "Pro Streamer", icon: "🎬", description: "50 yayın yap", category: "streaming", condition: { type: "streams", count: 50 }, rewardCoins: 2000, rewardXP: 1000 },
  
  // Gifting
  { id: "first_gift_sent", name: "İlk Hediye", nameEn: "First Gift", icon: "🎁", description: "İlk hediyeni gönder", category: "gifting", condition: { type: "gifts_sent", count: 1 }, rewardCoins: 50, rewardXP: 25 },
  { id: "gifter_50", name: "Cömert", nameEn: "Generous", icon: "💝", description: "50 hediye gönder", category: "gifting", condition: { type: "gifts_sent", count: 50 }, rewardCoins: 500, rewardXP: 200 },
  { id: "first_gift_received", name: "İlk Hediye Aldım", nameEn: "Gift Received", icon: "🎀", description: "İlk hediyeni al", category: "gifting", condition: { type: "gifts_received", count: 1 }, rewardCoins: 25, rewardXP: 10 },
  
  // Milestones
  { id: "level_5", name: "Seviye 5", nameEn: "Level 5", icon: "🏅", description: "Seviye 5'e ulaş", category: "milestone", condition: { type: "level", count: 5 }, rewardCoins: 500, rewardXP: 0 },
  { id: "level_10", name: "Seviye 10", nameEn: "Level 10", icon: "🏆", description: "Seviye 10'a ulaş", category: "milestone", condition: { type: "level", count: 10 }, rewardCoins: 2000, rewardXP: 0 },
  { id: "coins_1000", name: "Zengin", nameEn: "Rich", icon: "💰", description: "1000 coin biriktir", category: "milestone", condition: { type: "coins", count: 1000 }, rewardCoins: 0, rewardXP: 100 },
  { id: "coins_10000", name: "Milyoner", nameEn: "Millionaire", icon: "💎", description: "10000 coin biriktir", category: "milestone", condition: { type: "coins", count: 10000 }, rewardCoins: 0, rewardXP: 500 },
  { id: "verified", name: "Doğrulanmış", nameEn: "Verified", icon: "✅", description: "Profilini doğrula", category: "milestone", condition: { type: "verified", count: 1 }, rewardCoins: 200, rewardXP: 100 },
];

// =============================================
// ACHIEVEMENT CHECK ENGINE
// =============================================

/**
 * Belirli bir achievement'ı kontrol et ve kilidi açılmamışsa aç
 */
const tryUnlockAchievement = async (userId, achievementId) => {
  try {
    const user = await User.findById(userId).select("achievements coins xp level followers");
    if (!user) return null;

    // Zaten açılmış mı?
    const alreadyUnlocked = user.achievements?.some((a) => a.id === achievementId);
    if (alreadyUnlocked) return null;

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
      case "verified":
        const fullUser = await User.findById(userId).select("isVerified");
        conditionMet = fullUser?.isVerified === true;
        break;
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
      if (achievement.rewardCoins > 0) updateOps.$inc.coins = achievement.rewardCoins;
      if (achievement.rewardXP > 0) {
        updateOps.$inc.xp = achievement.rewardXP;
        updateOps.$inc.totalXpEarned = achievement.rewardXP;
      }
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updateOps, { new: true })
      .select("coins xp level achievements");

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
    console.error("tryUnlockAchievement error:", err);
    return null;
  }
};

/**
 * Seviye bazlı başarımları kontrol et
 */
const checkLevelAchievements = async (userId, level) => {
  if (level >= 5) await tryUnlockAchievement(userId, "level_5");
  if (level >= 10) await tryUnlockAchievement(userId, "level_10");
};
exports.checkLevelAchievements = checkLevelAchievements;

/**
 * Takipçi bazlı başarımları kontrol et
 */
exports.checkFollowerAchievements = async (userId, followerCount) => {
  if (followerCount >= 1) await tryUnlockAchievement(userId, "first_follow");
  if (followerCount >= 10) await tryUnlockAchievement(userId, "popular_10");
  if (followerCount >= 50) await tryUnlockAchievement(userId, "popular_50");
  if (followerCount >= 100) await tryUnlockAchievement(userId, "popular_100");
  if (followerCount >= 500) await tryUnlockAchievement(userId, "popular_500");
};

/**
 * Hediye gönderme bazlı başarımları kontrol et
 */
exports.checkGiftSentAchievements = async (userId, totalSent) => {
  if (totalSent >= 1) await tryUnlockAchievement(userId, "first_gift_sent");
  if (totalSent >= 50) await tryUnlockAchievement(userId, "gifter_50");
};

/**
 * Hediye alma bazlı başarımları kontrol et
 */
exports.checkGiftReceivedAchievements = async (userId) => {
  await tryUnlockAchievement(userId, "first_gift_received");
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
exports.checkVerificationAchievement = async (userId) => {
  await tryUnlockAchievement(userId, "verified");
};

/**
 * Coin bazlı başarımları kontrol et
 */
exports.checkCoinAchievements = async (userId, coinBalance) => {
  if (coinBalance >= 1000) await tryUnlockAchievement(userId, "coins_1000");
  if (coinBalance >= 10000) await tryUnlockAchievement(userId, "coins_10000");
};

// =============================================
// API ENDPOINTS
// =============================================

// GET /api/achievements - Tüm başarımlar (kullanıcı durumu ile)
exports.getAchievements = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("achievements");
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
    console.error("getAchievements error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/achievements/recent - Son kazanılan başarımlar
exports.getRecentAchievements = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("achievements");

    const recent = (user?.achievements || [])
      .sort((a, b) => new Date(b.unlockedAt) - new Date(a.unlockedAt))
      .slice(0, 5);

    res.json({ success: true, achievements: recent });
  } catch (err) {
    console.error("getRecentAchievements error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

module.exports = exports;
