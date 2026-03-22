// src/controllers/spinController.js
const SpinReward = require("../models/SpinReward");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const SystemSettings = require("../models/SystemSettings");
const { createNotification } = require("./notificationController");

// =============================================
// SPIN HELPER
// =============================================

/**
 * Ağırlıklı rastgele seçim
 */
const weightedRandom = (rewards) => {
  const totalWeight = rewards.reduce((sum, r) => sum + r.probability, 0);
  let random = Math.random() * totalWeight;

  for (const reward of rewards) {
    random -= reward.probability;
    if (random <= 0) return reward;
  }

  return rewards[rewards.length - 1];
};

// =============================================
// API ENDPOINTS
// =============================================

// GET /api/spin/rewards - Çark ödüllerini getir
exports.getRewards = async (req, res) => {
  try {
    const rewards = await SpinReward.find({ isActive: true })
      .sort({ order: 1 })
      .lean();

    res.json({ success: true, rewards });
  } catch (err) {
    console.error("getRewards error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/spin/status - Çark durumu (bugün kullanılabilir mi?)
exports.getSpinStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("spinLastUsedAt isVip vipTier");

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    // ✅ Count today's spins from transactions
    const todaySpinCount = await Transaction.countDocuments({
      user: userId,
      type: "spin_reward",
      createdAt: { $gte: todayStart }
    });

    // ✅ Get spin limit based on VIP status
    const settings = await SystemSettings.findOne().lean();
    let dailyLimit = settings?.dailySpinLimit || 1;
    
    if (user.isVip) {
      const vipLimits = {
        diamond: (settings?.vipDailySpinLimit || 2) + 1, // Diamond gets +1 extra
        gold: settings?.vipDailySpinLimit || 2,
        silver: settings?.vipDailySpinLimit || 2,
      };
      dailyLimit = vipLimits[user.vipTier] || settings?.vipDailySpinLimit || 2;
    }

    const canSpin = todaySpinCount < dailyLimit;
    const remainingSpins = Math.max(0, dailyLimit - todaySpinCount);
    const nextSpinAt = canSpin ? null : new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    res.json({
      success: true,
      canSpin,
      remainingSpins,
      dailyLimit,
      todaySpinCount,
      extraSpinAvailable: user.isVip && todaySpinCount >= 1 && todaySpinCount < dailyLimit,
      nextSpinAt,
      lastSpinAt: user.spinLastUsedAt,
    });
  } catch (err) {
    console.error("getSpinStatus error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/spin/spin - Çarkı çevir
exports.spin = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("coins spinLastUsedAt isVip vipTier vipExpiresAt");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const settings = await SystemSettings.findOne().lean();
    let dailyLimit = settings?.dailySpinLimit || 1;
    
    if (user.isVip) {
      const vipLimits = {
        diamond: (settings?.vipDailySpinLimit || 2) + 1,
        gold: settings?.vipDailySpinLimit || 2,
        silver: settings?.vipDailySpinLimit || 2,
      };
      dailyLimit = vipLimits[user.vipTier] || settings?.vipDailySpinLimit || 2;
    }

    // Atomik spin kilidi: Önce placeholder Transaction oluştur, sonra sayıyı kontrol et
    const spinTx = await Transaction.create({
      user: userId,
      type: "spin_reward",
      amount: 0,
      status: "pending",
      description: "Çark çevriliyor...",
    });

    // Bugünkü spin sayısını kontrol et (az önce oluşturduğumuz dahil)
    const todaySpinCount = await Transaction.countDocuments({
      user: userId,
      type: "spin_reward",
      createdAt: { $gte: todayStart },
    });

    if (todaySpinCount > dailyLimit) {
      // Limiti aştık — oluşturduğumuz placeholder'ı sil
      await Transaction.findByIdAndDelete(spinTx._id);
      return res.status(429).json({
        success: false,
        message: "Bugünkü çark hakkınız doldu",
        nextSpinAt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
        dailyLimit,
        todaySpinCount: todaySpinCount - 1,
      });
    }

    // Aktif ödülleri getir
    const rewards = await SpinReward.find({ isActive: true }).sort({ order: 1 });
    if (rewards.length === 0) {
      await Transaction.findByIdAndDelete(spinTx._id);
      return res.status(500).json({ success: false, message: "Çark ödülleri ayarlanmamış" });
    }

    // Ödül seç
    const selectedReward = weightedRandom(rewards);

    // Ödülü uygula
    let rewardMessage = "";
    const updateOps = { $set: { spinLastUsedAt: now } };

    switch (selectedReward.type) {
      case "coins":
        updateOps.$inc = { coins: selectedReward.value };
        rewardMessage = `${selectedReward.value} coin kazandınız!`;
        break;

      case "xp":
        updateOps.$inc = { xp: selectedReward.value, totalXpEarned: selectedReward.value };
        rewardMessage = `${selectedReward.value} XP kazandınız!`;
        break;

      case "vip_days":
        const currentExpiry = user.vipExpiresAt && user.vipExpiresAt > now
          ? user.vipExpiresAt
          : now;
        const newExpiry = new Date(currentExpiry.getTime() + selectedReward.value * 24 * 60 * 60 * 1000);
        updateOps.$set.isVip = true;
        updateOps.$set.vipExpiresAt = newExpiry;
        if (!user.isVip) updateOps.$set.vipTier = "silver";
        rewardMessage = `${selectedReward.value} günlük VIP kazandınız!`;
        break;

      case "nothing":
        rewardMessage = "Maalesef bir şey çıkmadı, yarın tekrar deneyin!";
        break;

      default:
        rewardMessage = selectedReward.label;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updateOps, {
      new: true,
    }).select("coins xp level");

    // Seviye kontrolü
    if (selectedReward.type === "xp" && updatedUser) {
      const newLevel = updatedUser.calculateLevel();
      if (newLevel !== updatedUser.level) {
        await User.findByIdAndUpdate(userId, { $set: { level: newLevel } });
      }
    }

    // Placeholder Transaction'ı gerçek verilerle güncelle
    await Transaction.findByIdAndUpdate(spinTx._id, {
      $set: {
        amount: selectedReward.value || 0,
        balanceAfter: updatedUser?.coins || 0,
        status: "completed",
        description: `Çark ödülü: ${selectedReward.label}`,
        metadata: {
          rewardType: selectedReward.type,
          rewardLabel: selectedReward.label,
        },
      },
    });

    res.json({
      success: true,
      reward: {
        label: selectedReward.label,
        type: selectedReward.type,
        value: selectedReward.value,
        icon: selectedReward.icon,
        color: selectedReward.color,
      },
      message: rewardMessage,
      newBalance: updatedUser?.coins || 0,
      nextSpinAt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    console.error("spin error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ADMIN ENDPOINTS
// =============================================

// POST /api/spin/admin/seed - Varsayılan ödüller oluştur
exports.seedRewards = async (req, res) => {
  try {
    const existingCount = await SpinReward.countDocuments();
    if (existingCount > 0) {
      return res.json({
        success: false,
        message: `Zaten ${existingCount} ödül mevcut.`,
      });
    }

    const defaultRewards = [
      { label: "50 Coin", labelEn: "50 Coins", type: "coins", value: 50, probability: 25, color: "#FFD700", icon: "💰", order: 1 },
      { label: "100 Coin", labelEn: "100 Coins", type: "coins", value: 100, probability: 15, color: "#FFA500", icon: "💎", order: 2 },
      { label: "200 Coin", labelEn: "200 Coins", type: "coins", value: 200, probability: 8, color: "#FF6347", icon: "🏆", order: 3 },
      { label: "500 Coin", labelEn: "500 Coins", type: "coins", value: 500, probability: 3, color: "#FF4500", icon: "👑", order: 4 },
      { label: "25 XP", labelEn: "25 XP", type: "xp", value: 25, probability: 20, color: "#32CD32", icon: "⭐", order: 5 },
      { label: "50 XP", labelEn: "50 XP", type: "xp", value: 50, probability: 10, color: "#00CED1", icon: "🌟", order: 6 },
      { label: "1 Gün VIP", labelEn: "1 Day VIP", type: "vip_days", value: 1, probability: 5, color: "#8A2BE2", icon: "💜", order: 7 },
      { label: "Boş", labelEn: "Nothing", type: "nothing", value: 0, probability: 14, color: "#808080", icon: "😔", order: 8 },
    ];

    await SpinReward.insertMany(defaultRewards);
    res.json({
      success: true,
      message: `${defaultRewards.length} ödül oluşturuldu`,
      count: defaultRewards.length,
    });
  } catch (err) {
    console.error("seedRewards error:", err);
    res.status(500).json({ success: false, message: "Seed başarısız" });
  }
};

// GET /api/spin/admin/rewards - Tüm ödülleri getir
exports.adminGetRewards = async (req, res) => {
  try {
    const rewards = await SpinReward.find().sort({ order: 1 }).lean();
    res.json({ success: true, rewards });
  } catch (err) {
    console.error("adminGetRewards error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/spin/admin/rewards - Ödül oluştur
exports.adminCreateReward = async (req, res) => {
  try {
    const reward = await SpinReward.create(req.body);
    res.json({ success: true, reward });
  } catch (err) {
    console.error("adminCreateReward error:", err);
    res.status(500).json({ success: false, message: "Ödül oluşturulamadı" });
  }
};

// PUT /api/spin/admin/rewards/:rewardId - Ödül güncelle
exports.adminUpdateReward = async (req, res) => {
  try {
    const { rewardId } = req.params;
    const reward = await SpinReward.findByIdAndUpdate(
      rewardId,
      { $set: req.body },
      { new: true }
    );
    if (!reward) {
      return res.status(404).json({ success: false, message: "Ödül bulunamadı" });
    }
    res.json({ success: true, reward });
  } catch (err) {
    console.error("adminUpdateReward error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/spin/admin/rewards/:rewardId - Ödül sil
exports.adminDeleteReward = async (req, res) => {
  try {
    const { rewardId } = req.params;
    await SpinReward.findByIdAndDelete(rewardId);
    res.json({ success: true, message: "Ödül silindi" });
  } catch (err) {
    console.error("adminDeleteReward error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
