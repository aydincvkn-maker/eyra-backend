const User = require("../models/User");
const SystemSettings = require("../models/SystemSettings");
const Transaction = require("../models/Transaction");
const { trackMissionProgress } = require("./missionController");
const { createNotification } = require("./notificationController");

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
          "Günde 2 çark çevirme",
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
          "Günde 3 çark çevirme",
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
          "Sınırsız çark çevirme",
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
    console.error("getVipPackages error:", err);
    res.status(500).json({ success: false, error: "Paketler alınamadı" });
  }
};

// VIP satın al (coin ile)
exports.purchaseVip = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { tier } = req.body;

    if (!["silver", "gold", "diamond"].includes(tier)) {
      return res.status(400).json({ success: false, error: "Geçersiz VIP tipi" });
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
      return res.status(404).json({ success: false, error: "Kullanıcı bulunamadı" });
    }

    if (user.coins < price) {
      return res.status(400).json({
        success: false,
        error: "Yetersiz coin",
        required: price,
        current: user.coins,
      });
    }

    // Mevcut VIP süresi varsa uzat, yoksa şimdiden başlat
    const now = new Date();
    const currentExpiry = user.vipExpiresAt && user.vipExpiresAt > now
      ? user.vipExpiresAt
      : now;
    const newExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);

    // Tier upgrade kontrolü
    const tierRank = { none: 0, silver: 1, gold: 2, diamond: 3 };
    const newTier = tierRank[tier] >= tierRank[user.vipTier || "none"] ? tier : user.vipTier;

    user.coins -= price;
    user.isVip = true;
    user.vipTier = newTier;
    user.vipExpiresAt = newExpiry;
    user.vipPurchasedAt = now;
    await user.save();

    // Transaction kaydı
    await Transaction.create({
      user: userId,
      type: "vip_purchase",
      amount: -price,
      balanceAfter: user.coins,
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
        body: `${tier.charAt(0).toUpperCase() + tier.slice(1)} VIP üyeliğiniz ${days} gün süreyle aktif!`,
      });
    } catch (_) {}

    res.json({
      success: true,
      message: `${tier} VIP aktif edildi`,
      vip: {
        isVip: true,
        vipTier: newTier,
        vipExpiresAt: newExpiry,
        daysRemaining: days,
      },
      coins: user.coins,
    });
  } catch (err) {
    console.error("purchaseVip error:", err);
    res.status(500).json({ success: false, error: "VIP satın alınamadı" });
  }
};

// VIP durumunu kontrol et
exports.getVipStatus = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).select("isVip vipTier vipExpiresAt vipPurchasedAt").lean();

    if (!user) {
      return res.status(404).json({ success: false, error: "Kullanıcı bulunamadı" });
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
    console.error("getVipStatus error:", err);
    res.status(500).json({ success: false, error: "VIP durumu alınamadı" });
  }
};

// ✅ Admin: VIP istatistikleri (performant aggregation)
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
    console.error("adminGetVipStats error:", err);
    res.status(500).json({ success: false, error: "İstatistikler alınamadı" });
  }
};

// Admin: VIP ver/kaldır
exports.adminSetVip = async (req, res) => {
  try {
    const { userId, tier, days } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "userId gerekli" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: "Kullanıcı bulunamadı" });
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
      return res.status(400).json({ success: false, error: "Geçersiz tier" });
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
        title: "VIP Hediye! 🎁",
        body: `Admin tarafından ${tier} VIP üyeliği ${grantDays} gün süreyle verildi!`,
      });
    } catch (_) {}

    res.json({
      success: true,
      message: `${tier} VIP ${grantDays} gün verildi`,
      user: { _id: user._id, name: user.name, vipTier: tier, vipExpiresAt: newExpiry },
    });
  } catch (err) {
    console.error("adminSetVip error:", err);
    res.status(500).json({ success: false, error: "VIP ayarlanamadı" });
  }
};
