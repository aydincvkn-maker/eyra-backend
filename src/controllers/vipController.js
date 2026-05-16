const User = require("../models/User");
const SystemSettings = require("../models/SystemSettings");
const Transaction = require("../models/Transaction");
const { trackMissionProgress } = require("./missionController");
const { createNotification } = require("./notificationController");
const { logger } = require("../utils/logger");

// VIP paketlerini getir
exports.getVipPackages = async (req, res) => {
  try {
    const settings = await SystemSettings.findOne().lean();
    const packages = [
      {
        tier: "silver",
        name: "Silver VIP",
        price: settings?.vipSilverPrice || 5000,
        days: settings?.vipSilverDays || 30,
        features: [
          "Günde 2 Otomatik Çeviri",
          "VIP rozeti",
          "Özel hediyeler",
        ],
      },
      {
        tier: "gold",
        name: "Gold VIP",
        price: settings?.vipGoldPrice || 15000,
        days: settings?.vipGoldDays || 30,
        features: [
          "Günde 3 Otomatik Çeviri",
          "Gold rozeti",
          "Özel hediyeler",
          "Öncelikli destek",
          "%10 hediye bonusu",
        ],
      },
      {
        tier: "diamond",
        name: "Diamond VIP",
        price: settings?.vipDiamondPrice || 50000,
        days: settings?.vipDiamondDays || 30,
        features: [
          "Sınırsız Otomatik Çeviri",
          "Diamond rozeti",
          "Özel hediyeler",
          "Öncelikli destek",
          "%20 hediye bonusu",
          "Profil vurgulama",
          "Özel animasyonlar",
        ],
      },
    ];

    res.json({ success: true, packages });
  } catch (err) {
    logger.error("getVipPackages error:", err);
    res.status(500).json({
      success: false,
      message: "Paketler alınamadı",
      error: "Paketler alınamadı",
    });
  }
};

// VIP satın al (coin ile)
exports.purchaseVip = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { tier } = req.body;

    if (!["silver", "gold", "diamond"].includes(tier)) {
      return res.status(400).json({
      success: false,
      message: "Geçersiz VIP tipi",
      error: "Geçersiz VIP tipi",
    });
    }

    const settings = await SystemSettings.findOne().lean();
    const priceMap = {
      silver: settings?.vipSilverPrice || 5000,
      gold: settings?.vipGoldPrice || 15000,
      diamond: settings?.vipDiamondPrice || 50000,
    };
    const daysMap = {
      silver: settings?.vipSilverDays || 30,
      gold: settings?.vipGoldDays || 30,
      diamond: settings?.vipDiamondDays || 30,
    };

    const price = priceMap[tier];
    const days = daysMap[tier];

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
      success: false,
      message: "Kullanıcı bulunamadı",
      error: "Kullanıcı bulunamadı",
    });
    }

    if (user.coins < price) {
      return res.status(400).json({
        success: false,
        message: "Yetersiz coin",
        error: "Yetersiz coin",
        required: price,
        current: user.coins,
      });
    }

    const now = new Date();
    const daysMs = days * 24 * 60 * 60 * 1000;
    const tierRank = { none: 0, silver: 1, gold: 2, diamond: 3 };
    const purchasedTierRank = tierRank[tier];

    // 🛡️ Atomik coin düşürme + VIP güncelleme (aggregation pipeline ile TOCTOU önleme)
    // vipExpiresAt ve vipTier DB'deki GÜNCEL değerden hesaplanır, stale read yok
    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, coins: { $gte: price } },
      [
        {
          $set: {
            coins: { $subtract: ["$coins", price] },
            isVip: true,
            vipPurchasedAt: now,
            // Mevcut süre dolmamışsa uzat, dolmuşsa şimdiden başlat
            vipExpiresAt: {
              $add: [
                { $cond: {
                  if: { $and: [
                    { $ne: ["$vipExpiresAt", null] },
                    { $gt: ["$vipExpiresAt", now] }
                  ]},
                  then: "$vipExpiresAt",
                  else: now
                }},
                daysMs
              ]
            },
            // Tier upgrade: sadece eşit veya yüksek tier'e geçiş
            vipTier: {
              $cond: {
                if: { $gte: [
                  purchasedTierRank,
                  { $switch: {
                    branches: [
                      { case: { $eq: ["$vipTier", "silver"] }, then: 1 },
                      { case: { $eq: ["$vipTier", "gold"] }, then: 2 },
                      { case: { $eq: ["$vipTier", "diamond"] }, then: 3 },
                    ],
                    default: 0
                  }}
                ]},
                then: tier,
                else: "$vipTier"
              }
            }
          }
        }
      ],
      { new: true, projection: { coins: 1, isVip: 1, vipTier: 1, vipExpiresAt: 1 } }
    );
    if (!updatedUser) {
      // Coin sonradan düşmüş olabilir (eş zamanlı işlem)
      return res.status(400).json({
        success: false,
        message: "Yetersiz coin (eş zamanlı işlem)",
        error: "Yetersiz coin (eş zamanlı işlem)",
        required: price,
      });
    }

    // Transaction kaydı
    await Transaction.create({
      user: userId,
      type: "vip_purchase",
      amount: -price,
      balanceAfter: updatedUser.coins,
      description: `${tier.charAt(0).toUpperCase() + tier.slice(1)} VIP satın alındı (${days} gün)`,
      status: "completed",
    });

    // Mission tracking
    try { await trackMissionProgress(userId, "vip_purchase"); } catch (_) {}

    // Notification
    try {
      await createNotification({
        recipientId: userId,
        type: "system",
        title: "VIP Aktif! 🎉",
        titleEn: "VIP Active! 🎉",
        body: `${tier.charAt(0).toUpperCase() + tier.slice(1)} VIP üyeliğiniz ${days} gün süreyle aktif!`,
        bodyEn: `Your ${tier.charAt(0).toUpperCase() + tier.slice(1)} VIP membership is active for ${days} days!`,
      });
    } catch (_) {}

    res.json({
      success: true,
      message: `${tier} VIP aktif edildi`,
      vip: {
        isVip: true,
        vipTier: updatedUser.vipTier,
        vipExpiresAt: updatedUser.vipExpiresAt,
        daysRemaining: days,
      },
      coins: updatedUser.coins,
    });
  } catch (err) {
    logger.error("purchaseVip error:", err);
    res.status(500).json({
      success: false,
      message: "VIP satın alınamadı",
      error: "VIP satın alınamadı",
    });
  }
};

// VIP durumunu kontrol et
exports.getVipStatus = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).select("isVip vipTier vipExpiresAt vipPurchasedAt").lean();

    if (!user) {
      return res.status(404).json({
      success: false,
      message: "Kullanıcı bulunamadı",
      error: "Kullanıcı bulunamadı",
    });
    }

    const now = new Date();
    const isActive = user.isVip && user.vipExpiresAt && user.vipExpiresAt > now;
    const daysRemaining = isActive
      ? Math.ceil((user.vipExpiresAt - now) / (24 * 60 * 60 * 1000))
      : 0;

    res.json({
      success: true,
      vip: {
        isVip: isActive,
        vipTier: isActive ? user.vipTier : "none",
        vipExpiresAt: user.vipExpiresAt,
        vipPurchasedAt: user.vipPurchasedAt,
        daysRemaining,
      },
    });
  } catch (err) {
    logger.error("getVipStatus error:", err);
    res.status(500).json({
      success: false,
      message: "VIP durumu alınamadı",
      error: "VIP durumu alınamadı",
    });
  }
};

// Ô£à Admin: VIP istatistikleri (performant aggregation)
exports.adminGetVipStats = async (req, res) => {
  try {
    const stats = await User.aggregate([
      { $match: { isVip: true } },
      {
        $group: {
          _id: "$vipTier",
          count: { $sum: 1 },
        },
      },
    ]);

    const result = { total: 0, silver: 0, gold: 0, diamond: 0 };
    for (const s of stats) {
      result[s._id] = s.count;
      result.total += s.count;
    }

    // Expiring soon (within 7 days)
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const expiringSoon = await User.countDocuments({
      isVip: true,
      vipExpiresAt: { $lte: soon, $gt: new Date() },
    });

    result.expiringSoon = expiringSoon;

    res.json({ success: true, stats: result });
  } catch (err) {
    logger.error("adminGetVipStats error:", err);
    res.status(500).json({
      success: false,
      message: "İstatistikler alınamadı",
      error: "İstatistikler alınamadı",
    });
  }
};

// Admin: VIP ver/kaldır
exports.adminSetVip = async (req, res) => {
  try {
    const { userId, tier, days } = req.body;

    if (!userId) {
      return res.status(400).json({
      success: false,
      message: "userId gerekli",
      error: "userId gerekli",
    });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
      success: false,
      message: "Kullanıcı bulunamadı",
      error: "Kullanıcı bulunamadı",
    });
    }

    if (tier === "none" || !tier) {
      // VIP kaldır
      user.isVip = false;
      user.vipTier = "none";
      user.vipExpiresAt = null;
      await user.save();

      return res.json({ success: true, message: "VIP kaldırıldı" });
    }

    if (!["silver", "gold", "diamond"].includes(tier)) {
      return res.status(400).json({
      success: false,
      message: "Geçersiz tier",
      error: "Geçersiz tier",
    });
    }

    const grantDays = days || 30;
    const now = new Date();
    const currentExpiry = user.vipExpiresAt && user.vipExpiresAt > now
      ? user.vipExpiresAt
      : now;
    const newExpiry = new Date(currentExpiry.getTime() + grantDays * 24 * 60 * 60 * 1000);

    user.isVip = true;
    user.vipTier = tier;
    user.vipExpiresAt = newExpiry;
    user.vipPurchasedAt = now;
    await user.save();

    try {
      await createNotification({
        recipientId: userId,
        type: "system",
        title: "VIP Hediye! 🎉",
        titleEn: "VIP Gift! 🎉",
        body: `Admin tarafından ${tier} VIP üyeliği ${grantDays} gün süreyle verildi!`,
        bodyEn: `${tier} VIP membership granted by admin for ${grantDays} days!`,
      });
    } catch (_) {}

    res.json({
      success: true,
      message: `${tier} VIP ${grantDays} gün verildi`,
      user: { _id: user._id, name: user.name, vipTier: tier, vipExpiresAt: newExpiry },
    });
  } catch (err) {
    logger.error("adminSetVip error:", err);
    res.status(500).json({
      success: false,
      message: "VIP ayarlanamadı",
      error: "VIP ayarlanamadı",
    });
  }
};
