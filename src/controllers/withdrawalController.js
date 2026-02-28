// src/controllers/withdrawalController.js
const Withdrawal = require("../models/Withdrawal");
const User = require("../models/User");
const Transaction = require("../models/Transaction");

// =============================================
// SABITLER
// =============================================
const COIN_TO_USD_RATE = 0.01;      // 1 coin = 0.01 USD (100 coin = 1$)
const MIN_WITHDRAWAL_COINS = 5000;  // Minimum çekim: 5000 coin (50$)
const MAX_WITHDRAWAL_COINS = 500000; // Maksimum çekim: 500.000 coin (5000$)
const PLATFORM_FEE_PERCENT = 0;     // Çekim komisyonu %0 (isteğe bağlı)

// Birikim ödülleri (milestone bonusları)
const SAVINGS_MILESTONES = [
  { threshold: 10000,  bonusPercent: 2,  label: "Bronz Yayıncı",    icon: "🥉" },
  { threshold: 25000,  bonusPercent: 3,  label: "Gümüş Yayıncı",    icon: "🥈" },
  { threshold: 50000,  bonusPercent: 5,  label: "Altın Yayıncı",    icon: "🥇" },
  { threshold: 100000, bonusPercent: 7,  label: "Platin Yayıncı",   icon: "💎" },
  { threshold: 250000, bonusPercent: 10, label: "Elmas Yayıncı",    icon: "👑" },
  { threshold: 500000, bonusPercent: 15, label: "Efsane Yayıncı",   icon: "🌟" },
];

// =============================================
// HAFTALIK SEVİYE & MAAŞ SİSTEMİ
// =============================================
// Fotoğraftaki tabloya göre: Liveroom hediye + Özel görüşme dahil haftalık
const HOST_SALARY_LEVELS = [
  {
    level: 1,
    minGifts: 0,
    maxGifts: 34999,
    minGiftsWithCalls: 0,
    maxGiftsWithCalls: 34999,
    salaryPerHour: 0,
    hoursPerDay: 0,
    salaryPerWeek: 0,
    salaryType: "none",
    label: "Seviye 1",
    icon: "⭐",
    color: "#9E9E9E",
  },
  {
    level: 2,
    minGifts: 35000,
    maxGifts: 69999,
    minGiftsWithCalls: 35000,
    maxGiftsWithCalls: 99999,
    salaryPerHour: 0,
    salaryPerDay: 5,
    hoursPerDay: 2,
    salaryPerWeek: 35,
    salaryType: "daily",
    label: "Seviye 2",
    icon: "🌟",
    color: "#FF9800",
  },
  {
    level: 3,
    minGifts: 70000,
    maxGifts: 174999,
    minGiftsWithCalls: 100000,
    maxGiftsWithCalls: 209999,
    salaryPerHour: 5,
    hoursPerDay: 2,
    salaryPerWeek: 70,
    salaryType: "hourly",
    label: "Seviye 3",
    icon: "💫",
    color: "#4CAF50",
  },
  {
    level: 4,
    minGifts: 175000,
    maxGifts: 209999,
    minGiftsWithCalls: 210000,
    maxGiftsWithCalls: 299999,
    salaryPerHour: 6,
    hoursPerDay: 2.5,
    salaryPerWeek: 126,
    salaryType: "hourly",
    label: "Seviye 4",
    icon: "🔥",
    color: "#2196F3",
  },
  {
    level: 5,
    minGifts: 210000,
    maxGifts: 499999,
    minGiftsWithCalls: 300000,
    maxGiftsWithCalls: 499999,
    salaryPerHour: 7,
    hoursPerDay: 2.5,
    salaryPerWeek: 147,
    salaryType: "hourly",
    label: "Seviye 5",
    icon: "💎",
    color: "#9C27B0",
  },
  {
    level: 6,
    minGifts: 500000,
    maxGifts: Infinity,
    minGiftsWithCalls: 500000,
    maxGiftsWithCalls: Infinity,
    salaryPerHour: 10,
    hoursPerDay: 2.5,
    salaryPerWeek: 210,
    salaryType: "hourly",
    label: "Seviye 6",
    icon: "👑",
    color: "#FFD700",
  },
];

/**
 * Haftalık hediye miktarına göre seviye hesapla
 * İki kriter var: sadece liveroom hediye VE hediye+özel görüşme
 * İkisinden yüksek olanı baz alır
 */
function calculateHostLevel(weeklyGifts, weeklyGiftsWithCalls) {
  let bestLevel = HOST_SALARY_LEVELS[0]; // Default Level 1
  
  for (const lvl of HOST_SALARY_LEVELS) {
    // Sadece hediye kriteri
    const meetsGiftReq = weeklyGifts >= lvl.minGifts;
    // Hediye + özel görüşme kriteri
    const meetsCallReq = weeklyGiftsWithCalls >= lvl.minGiftsWithCalls;
    
    if (meetsGiftReq || meetsCallReq) {
      bestLevel = lvl;
    }
  }
  
  return bestLevel;
}

// =============================================
// YAYINCI BİLGİLERİ
// =============================================

// GET /api/withdrawals/broadcaster-info — Yayıncı oda bilgileri
exports.getBroadcasterInfo = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select(
      "coins totalEarnings gender broadcasterContract iban bankName accountHolder name username profileImage level followers"
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Toplam çekilen coin
    const totalWithdrawn = await Withdrawal.aggregate([
      { $match: { user: user._id, status: { $in: ["approved", "paid"] } } },
      { $group: { _id: null, total: { $sum: "$amountCoins" } } },
    ]);
    const withdrawnCoins = totalWithdrawn[0]?.total || 0;

    // Bekleyen çekim
    const pendingWithdrawals = await Withdrawal.aggregate([
      { $match: { user: user._id, status: "pending" } },
      { $group: { _id: null, total: { $sum: "$amountCoins" }, count: { $sum: 1 } } },
    ]);
    const pendingCoins = pendingWithdrawals[0]?.total || 0;
    const pendingCount = pendingWithdrawals[0]?.count || 0;

    // Çekilebilir bakiye
    const availableCoins = Math.max(0, user.coins - pendingCoins);

    // Birikim ödülü (milestone)
    const currentMilestone = SAVINGS_MILESTONES
      .filter(m => user.totalEarnings >= m.threshold)
      .pop() || null;

    const nextMilestone = SAVINGS_MILESTONES
      .find(m => user.totalEarnings < m.threshold) || null;

    const progressToNext = nextMilestone
      ? Math.min(100, Math.round((user.totalEarnings / nextMilestone.threshold) * 100))
      : 100;

    // Son çekimler
    const recentWithdrawals = await Withdrawal.find({ user: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // İstatistikler
    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0, 0, 0, 0);

    const monthlyEarnings = await Transaction.aggregate([
      { $match: { user: user._id, type: "gift_received", createdAt: { $gte: thisMonthStart } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    res.json({
      success: true,
      broadcaster: {
        name: user.name,
        username: user.username,
        profileImage: user.profileImage,
        level: user.level,
        followers: user.followers,
        gender: user.gender,
        contractSigned: user.broadcasterContract?.signed === true,
        contractSignedAt: user.broadcasterContract?.signedAt || null,
      },
      balance: {
        currentCoins: user.coins,
        availableCoins,
        pendingCoins,
        pendingCount,
        totalEarnings: user.totalEarnings,
        totalWithdrawn: withdrawnCoins,
        coinToUsdRate: COIN_TO_USD_RATE,
        minWithdrawalCoins: MIN_WITHDRAWAL_COINS,
        maxWithdrawalCoins: MAX_WITHDRAWAL_COINS,
        platformFeePercent: PLATFORM_FEE_PERCENT,
      },
      bank: {
        iban: user.iban || "",
        bankName: user.bankName || "",
        accountHolder: user.accountHolder || "",
      },
      milestone: {
        current: currentMilestone,
        next: nextMilestone,
        progressToNext,
        allMilestones: SAVINGS_MILESTONES,
      },
      stats: {
        monthlyEarnings: monthlyEarnings[0]?.total || 0,
      },
      recentWithdrawals,
    });
  } catch (err) {
    console.error("getBroadcasterInfo error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// SÖZLEŞME İMZALAMA
// =============================================

// POST /api/withdrawals/sign-contract — Yayıncı sözleşmesi imzala
exports.signContract = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    if (user.gender !== "female") {
      return res.status(403).json({ success: false, message: "Bu özellik yalnızca kadın yayıncılar için geçerlidir" });
    }

    if (user.broadcasterContract?.signed) {
      return res.json({ success: true, message: "Sözleşme zaten imzalanmış", alreadySigned: true });
    }

    user.broadcasterContract = {
      signed: true,
      signedAt: new Date(),
      ipAddress: req.ip || req.headers["x-forwarded-for"] || "",
      userAgent: req.headers["user-agent"] || "",
      version: "1.0",
    };
    await user.save();

    res.json({ success: true, message: "Sözleşme başarıyla imzalandı" });
  } catch (err) {
    console.error("signContract error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// BANKA BİLGİLERİ
// =============================================

// PUT /api/withdrawals/bank-info — Banka bilgileri güncelle
exports.updateBankInfo = async (req, res) => {
  try {
    const userId = req.user.id;
    const { iban, bankName, accountHolder } = req.body;

    if (!iban || !bankName || !accountHolder) {
      return res.status(400).json({ success: false, message: "IBAN, banka adı ve hesap sahibi gerekli" });
    }

    // IBAN format validasyonu (basit)
    const cleanIban = iban.replace(/\s/g, "").toUpperCase();
    if (cleanIban.length < 15 || cleanIban.length > 34) {
      return res.status(400).json({ success: false, message: "Geçersiz IBAN formatı" });
    }

    await User.findByIdAndUpdate(userId, {
      $set: {
        iban: cleanIban,
        bankName: bankName.trim(),
        accountHolder: accountHolder.trim(),
      },
    });

    res.json({ success: true, message: "Banka bilgileri güncellendi" });
  } catch (err) {
    console.error("updateBankInfo error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ÇEKİM TALEPLERİ
// =============================================

// POST /api/withdrawals/request — Çekim talebi oluştur
exports.createWithdrawalRequest = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amountCoins } = req.body;

    if (!amountCoins || amountCoins <= 0) {
      return res.status(400).json({ success: false, message: "Geçerli bir miktar girin" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Kadın kontrolü
    if (user.gender !== "female") {
      return res.status(403).json({ success: false, message: "Bu özellik yalnızca kadın yayıncılar için geçerlidir" });
    }

    // Sözleşme kontrolü
    if (!user.broadcasterContract?.signed) {
      return res.status(403).json({ success: false, message: "Önce yayıncı sözleşmesini imzalamalısınız" });
    }

    // Banka bilgisi kontrolü
    if (!user.iban || !user.bankName || !user.accountHolder) {
      return res.status(400).json({ success: false, message: "Önce banka bilgilerinizi kaydedin" });
    }

    // Minimum/Maksimum kontrolü
    if (amountCoins < MIN_WITHDRAWAL_COINS) {
      return res.status(400).json({
        success: false,
        message: `Minimum çekim: ${MIN_WITHDRAWAL_COINS} coin ($${(MIN_WITHDRAWAL_COINS * COIN_TO_USD_RATE).toFixed(2)})`,
      });
    }
    if (amountCoins > MAX_WITHDRAWAL_COINS) {
      return res.status(400).json({
        success: false,
        message: `Maksimum çekim: ${MAX_WITHDRAWAL_COINS} coin`,
      });
    }

    // Bekleyen çekim kontrolü
    const pendingAgg = await Withdrawal.aggregate([
      { $match: { user: user._id, status: "pending" } },
      { $group: { _id: null, total: { $sum: "$amountCoins" } } },
    ]);
    const pendingCoins = pendingAgg[0]?.total || 0;

    const availableCoins = user.coins - pendingCoins;
    if (amountCoins > availableCoins) {
      return res.status(400).json({
        success: false,
        message: `Yetersiz bakiye. Kullanılabilir: ${availableCoins} coin`,
      });
    }

    // USD hesapla
    const amountUSD = amountCoins * COIN_TO_USD_RATE;

    // Çekim talebi oluştur
    const withdrawal = await Withdrawal.create({
      user: user._id,
      amountCoins,
      amountUSD,
      bankName: user.bankName,
      iban: user.iban,
      accountHolder: user.accountHolder,
      balanceBefore: user.coins,
      balanceAfter: user.coins - amountCoins,
    });

    console.log(`💰 Çekim talebi oluşturuldu: ${user.username} - ${amountCoins} coin ($${amountUSD.toFixed(2)})`);

    res.status(201).json({
      success: true,
      message: "Çekim talebiniz oluşturuldu. Admin onayını bekliyor.",
      withdrawal: {
        id: withdrawal._id,
        amountCoins: withdrawal.amountCoins,
        amountUSD: withdrawal.amountUSD,
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
      },
    });
  } catch (err) {
    console.error("createWithdrawalRequest error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/withdrawals/my — Kendi çekim geçmişim
exports.getMyWithdrawals = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20"), 1), 50);

    const total = await Withdrawal.countDocuments({ user: userId });
    const withdrawals = await Withdrawal.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      withdrawals,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getMyWithdrawals error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ADMIN ENDPOINTLERİ
// =============================================

// GET /api/withdrawals/admin/list — Tüm çekim taleplerini listele
exports.adminListWithdrawals = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20"), 1), 100);
    const status = req.query.status || null;

    const query = {};
    if (status) query.status = status;

    const total = await Withdrawal.countDocuments(query);
    const withdrawals = await Withdrawal.find(query)
      .populate("user", "username name profileImage email iban bankName accountHolder coins totalEarnings")
      .populate("reviewedBy", "username name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Özet istatistikler
    const [pending, approved, paid, rejected] = await Promise.all([
      Withdrawal.countDocuments({ status: "pending" }),
      Withdrawal.countDocuments({ status: "approved" }),
      Withdrawal.countDocuments({ status: "paid" }),
      Withdrawal.countDocuments({ status: "rejected" }),
    ]);

    res.json({
      success: true,
      withdrawals,
      stats: { pending, approved, paid, rejected },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("adminListWithdrawals error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/withdrawals/admin/:id/approve — Çekim talebini onayla
exports.adminApproveWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentReference, note } = req.body;

    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Çekim talebi bulunamadı" });
    }

    if (withdrawal.status !== "pending") {
      return res.status(400).json({ success: false, message: `Bu talep zaten '${withdrawal.status}' durumunda` });
    }

    // Kullanıcının coin'ini atomik düşür (TOCTOU race condition önleme)
    const user = await User.findOneAndUpdate(
      { _id: withdrawal.user, coins: { $gte: withdrawal.amountCoins } },
      { $inc: { coins: -withdrawal.amountCoins } },
      { new: true, select: "coins username" }
    );
    if (!user) {
      // Kullanıcı var mı yoksa coin mi yetersiz?
      const userCheck = await User.findById(withdrawal.user).select("coins").lean();
      if (!userCheck) {
        return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
      }
      return res.status(400).json({
        success: false,
        message: `Kullanıcının yeterli coin'i yok (mevcut: ${userCheck.coins}, talep: ${withdrawal.amountCoins})`,
      });
    }

    // Transaction kaydı
    await Transaction.create({
      user: user._id,
      type: "admin_deduct",
      amount: -withdrawal.amountCoins,
      balanceAfter: user.coins,
      description: `Çekim onayı — ${withdrawal.amountCoins} coin ($${withdrawal.amountUSD.toFixed(2)})`,
      metadata: { withdrawalId: withdrawal._id },
    });

    // Withdrawal güncelle
    withdrawal.status = "approved";
    withdrawal.reviewedBy = req.user.id;
    withdrawal.reviewedAt = new Date();
    withdrawal.reviewNote = note || "";
    withdrawal.paymentReference = paymentReference || "";
    withdrawal.balanceAfter = user.coins;
    await withdrawal.save();

    console.log(`✅ Çekim onaylandı: ${user.username} - ${withdrawal.amountCoins} coin`);

    res.json({ success: true, message: "Çekim talebi onaylandı", withdrawal });
  } catch (err) {
    console.error("adminApproveWithdrawal error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/withdrawals/admin/:id/reject — Çekim talebini reddet
exports.adminRejectWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Çekim talebi bulunamadı" });
    }

    if (withdrawal.status !== "pending") {
      return res.status(400).json({ success: false, message: `Bu talep zaten '${withdrawal.status}' durumunda` });
    }

    withdrawal.status = "rejected";
    withdrawal.reviewedBy = req.user.id;
    withdrawal.reviewedAt = new Date();
    withdrawal.rejectionReason = reason || "Belirtilmedi";
    await withdrawal.save();

    console.log(`❌ Çekim reddedildi: withdrawal ${id}`);

    res.json({ success: true, message: "Çekim talebi reddedildi", withdrawal });
  } catch (err) {
    console.error("adminRejectWithdrawal error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/withdrawals/admin/:id/mark-paid — Ödeme yapıldı olarak işaretle
exports.adminMarkPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentReference } = req.body;

    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Çekim talebi bulunamadı" });
    }

    if (withdrawal.status !== "approved") {
      return res.status(400).json({ success: false, message: "Sadece onaylanmış talepler 'ödendi' olarak işaretlenebilir" });
    }

    withdrawal.status = "paid";
    withdrawal.paidAt = new Date();
    withdrawal.paymentReference = paymentReference || withdrawal.paymentReference;
    await withdrawal.save();

    console.log(`💸 Ödeme yapıldı: withdrawal ${id}`);

    res.json({ success: true, message: "Ödeme yapıldı olarak işaretlendi", withdrawal });
  } catch (err) {
    console.error("adminMarkPaid error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
