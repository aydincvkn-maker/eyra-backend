// src/controllers/withdrawalController.js
const Withdrawal = require("../models/Withdrawal");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const salaryService = require("../services/salaryService");
const {
  COIN_TO_USD_RATE,
  MIN_WITHDRAWAL_COINS,
  MAX_WITHDRAWAL_COINS,
} = require("../config/env");

// Seviye sabitleri ve fonksiyonu salaryService'ten alınır (tek kaynak)
const { HOST_SALARY_LEVELS, calculateHostLevel } = salaryService;

// =============================================
// SABİTLER
// =============================================
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
// HOST_SALARY_LEVELS ve calculateHostLevel artık salaryService'ten import edilir.
// Aşağıdaki sabitler sadece API response mapping için kullanılır.
// (Bkz: dosya başındaki import)

// =============================================
// YAYINCI BİLGİLERİ
// =============================================

// GET /api/withdrawals/broadcaster-info — Yayıncı oda bilgileri
exports.getBroadcasterInfo = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select(
      "coins totalEarnings gender broadcasterContract iban bankName accountHolder preferredWithdrawMethod paparaId paparaName paypalEmail cryptoAddress cryptoNetwork wiseEmail wiseName name username profileImage level followers"
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

    // ── Haftalık seviye sistemi ──────────────────────────────
    // Sabit Pazartesi→Pazar hafta aralığı (salaryService ile aynı)
    const { weekStart, weekEnd: currentWeekEnd } = salaryService.getCurrentWeekRange();

    const weeklyGiftAgg = await Transaction.aggregate([
      { $match: { user: user._id, type: "gift_received", createdAt: { $gte: weekStart, $lte: currentWeekEnd } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const weeklyGifts = weeklyGiftAgg[0]?.total || 0;

    // Haftalık hediye + özel görüşme geliri (gift_received + call earnings)
    const weeklyTotalAgg = await Transaction.aggregate([
      { $match: { 
        user: user._id, 
        type: { $in: ["gift_received", "call_earning", "paid_call_earning"] },
        createdAt: { $gte: weekStart, $lte: currentWeekEnd } 
      }},
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const weeklyGiftsWithCalls = weeklyTotalAgg[0]?.total || 0;

    // Günlük kırılım (bu haftanın günleri)
    const dailyBreakdown = await Transaction.aggregate([
      { $match: { 
        user: user._id, 
        type: { $in: ["gift_received", "call_earning", "paid_call_earning"] },
        createdAt: { $gte: weekStart, $lte: currentWeekEnd } 
      }},
      { $group: { 
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        gifts: { 
          $sum: { $cond: [{ $eq: ["$type", "gift_received"] }, "$amount", 0] } 
        },
        calls: { 
          $sum: { $cond: [{ $ne: ["$type", "gift_received"] }, "$amount", 0] } 
        },
        total: { $sum: "$amount" }
      }},
      { $sort: { _id: 1 } },
    ]);

    // Mevcut seviye hesapla
    const currentSalaryLevel = calculateHostLevel(weeklyGifts, weeklyGiftsWithCalls);
    
    // Sonraki seviye
    const nextSalaryLevelIdx = HOST_SALARY_LEVELS.findIndex(l => l.level === currentSalaryLevel.level) + 1;
    const nextSalaryLevel = nextSalaryLevelIdx < HOST_SALARY_LEVELS.length 
      ? HOST_SALARY_LEVELS[nextSalaryLevelIdx] 
      : null;

    // Sonraki seviyeye kalan
    const giftsToNextLevel = nextSalaryLevel 
      ? Math.max(0, nextSalaryLevel.minGifts - weeklyGifts)
      : 0;
    const giftsWithCallsToNextLevel = nextSalaryLevel 
      ? Math.max(0, nextSalaryLevel.minGiftsWithCalls - weeklyGiftsWithCalls)
      : 0;

    // ── Maaş geçmişi & sonraki ödeme ─────────────────────────
    const salaryHistory = await salaryService.getUserSalaryHistory(userId, 4);
    const nextPayment = salaryService.getNextPaymentInfo();

    // ── Haftalık yayın süresi ────────────────────────────────
    const LiveStream = require("../models/LiveStream");
    const weeklyStreamAgg = await LiveStream.aggregate([
      { $match: { host: user._id, status: "ended", startedAt: { $gte: weekStart, $lte: currentWeekEnd } } },
      { $group: { _id: null, totalDuration: { $sum: "$duration" }, count: { $sum: 1 } } },
    ]);
    const weeklyStreamingMinutes = Math.floor((weeklyStreamAgg[0]?.totalDuration || 0) / 60);
    const weeklyStreamingHours = Math.round((weeklyStreamingMinutes / 60) * 100) / 100;
    const weeklyStreamCount = weeklyStreamAgg[0]?.count || 0;

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
      salaryLevel: {
        current: {
          level: currentSalaryLevel.level,
          label: currentSalaryLevel.label,
          description: currentSalaryLevel.description,
          icon: currentSalaryLevel.icon,
          color: currentSalaryLevel.color,
          salaryPerHour: currentSalaryLevel.salaryPerHour,
          salaryPerDay: currentSalaryLevel.salaryPerDay || 0,
          hoursPerDayLabel: currentSalaryLevel.hoursPerDayLabel,
          salaryPerWeek: currentSalaryLevel.salaryPerWeek,
          salaryType: currentSalaryLevel.salaryType,
        },
        next: nextSalaryLevel ? {
          level: nextSalaryLevel.level,
          label: nextSalaryLevel.label,
          description: nextSalaryLevel.description,
          icon: nextSalaryLevel.icon,
          color: nextSalaryLevel.color,
          salaryPerWeek: nextSalaryLevel.salaryPerWeek,
          minGifts: nextSalaryLevel.minGifts,
          minGiftsWithCalls: nextSalaryLevel.minGiftsWithCalls,
        } : null,
        weeklyGifts,
        weeklyGiftsWithCalls,
        giftsToNextLevel,
        giftsWithCallsToNextLevel,
        dailyBreakdown,
        allLevels: HOST_SALARY_LEVELS.map(l => ({
          level: l.level,
          label: l.label,
          description: l.description,
          icon: l.icon,
          color: l.color,
          minGifts: l.minGifts,
          maxGifts: l.maxGifts === Infinity ? null : l.maxGifts,
          minGiftsWithCalls: l.minGiftsWithCalls,
          maxGiftsWithCalls: l.maxGiftsWithCalls === Infinity ? null : l.maxGiftsWithCalls,
          salaryPerHour: l.salaryPerHour,
          salaryPerDay: l.salaryPerDay || 0,
          hoursPerDayLabel: l.hoursPerDayLabel,
          salaryPerWeek: l.salaryPerWeek,
          salaryType: l.salaryType,
        })),
        hostCommissionPercent: 45,
        weekStartDate: weekStart.toISOString(),
        weeklyStreamingMinutes,
        weeklyStreamingHours,
        weeklyStreamCount,
        recentSalaryPayments: salaryHistory.map(h => ({
          id: h._id,
          weekStart: h.weekStart,
          weekEnd: h.weekEnd,
          level: h.level,
          levelLabel: h.levelLabel,
          calculatedSalaryUSD: h.calculatedSalaryUSD,
          salaryCoins: h.salaryCoins,
          status: h.status,
          paidAt: h.paidAt,
          totalStreamingHours: h.totalStreamingHours,
          streamDaysCount: h.streamDaysCount,
        })),
        nextPayment: {
          currentWeekStart: nextPayment.currentWeekStart,
          currentWeekEnd: nextPayment.currentWeekEnd,
          nextPaymentDate: nextPayment.nextPaymentDate,
          daysUntilPayment: nextPayment.daysUntilPayment,
        },
      },
      recentWithdrawals,
      paymentInfo: {
        preferredMethod: user.preferredWithdrawMethod || 'bank',
        bank: {
          iban: user.iban || '',
          bankName: user.bankName || '',
          accountHolder: user.accountHolder || '',
        },
        papara: {
          paparaId: user.paparaId || '',
          accountHolder: user.paparaName || '',
        },
        paypal: {
          email: user.paypalEmail || '',
        },
        crypto: {
          address: user.cryptoAddress || '',
          network: user.cryptoNetwork || 'TRC20',
        },
        wise: {
          email: user.wiseEmail || '',
          accountHolder: user.wiseName || '',
        },
      },
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

// PUT /api/withdrawals/bank-info — Ödeme bilgileri güncelle (tüm yöntemler)
exports.updateBankInfo = async (req, res) => {
  try {
    const userId = req.user.id;
    const { method = 'bank', iban, bankName, accountHolder,
            paparaId, paparaName, paypalEmail,
            cryptoAddress, cryptoNetwork,
            wiseEmail, wiseName } = req.body;

    const updateData = { preferredWithdrawMethod: method };

    switch (method) {
      case 'papara':
        if (!paparaId || !paparaName)
          return res.status(400).json({ success: false, message: 'Papara ID ve hesap sahibi gerekli' });
        updateData.paparaId = paparaId.trim();
        updateData.paparaName = paparaName.trim();
        break;
      case 'paypal':
        if (!paypalEmail)
          return res.status(400).json({ success: false, message: 'PayPal e-posta gerekli' });
        updateData.paypalEmail = paypalEmail.trim().toLowerCase();
        break;
      case 'crypto':
        if (!cryptoAddress)
          return res.status(400).json({ success: false, message: 'Kripto cüzdan adresi gerekli' });
        updateData.cryptoAddress = cryptoAddress.trim();
        updateData.cryptoNetwork = (cryptoNetwork || 'TRC20').toUpperCase();
        break;
      case 'wise':
        if (!wiseEmail || !wiseName)
          return res.status(400).json({ success: false, message: 'Wise e-posta ve hesap sahibi gerekli' });
        updateData.wiseEmail = wiseEmail.trim();
        updateData.wiseName = wiseName.trim();
        break;
      default: { // bank
        if (!iban || !bankName || !accountHolder)
          return res.status(400).json({ success: false, message: 'IBAN, banka adı ve hesap sahibi gerekli' });
        const cleanIban = iban.replace(/\s/g, '').toUpperCase();
        if (cleanIban.length < 15 || cleanIban.length > 34)
          return res.status(400).json({ success: false, message: 'Geçersiz IBAN formatı' });
        updateData.iban = cleanIban;
        updateData.bankName = bankName.trim();
        updateData.accountHolder = accountHolder.trim();
        break;
      }
    }

    await User.findByIdAndUpdate(userId, { $set: updateData });
    res.json({ success: true, message: 'Ödeme bilgileri güncellendi' });
  } catch (err) {
    console.error('updateBankInfo error:', err);
    res.status(500).json({ success: false, message: 'Sunucu hatası' });
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

    // Ödeme bilgisi kontrolü
    const method = user.preferredWithdrawMethod || 'bank';
    let paymentDetails = {};
    let hasInfo = false;

    switch (method) {
      case 'papara':
        hasInfo = !!(user.paparaId && user.paparaName);
        paymentDetails = { paparaId: user.paparaId, accountHolder: user.paparaName };
        break;
      case 'paypal':
        hasInfo = !!user.paypalEmail;
        paymentDetails = { email: user.paypalEmail };
        break;
      case 'crypto':
        hasInfo = !!user.cryptoAddress;
        paymentDetails = { address: user.cryptoAddress, network: user.cryptoNetwork || 'TRC20' };
        break;
      case 'wise':
        hasInfo = !!(user.wiseEmail && user.wiseName);
        paymentDetails = { email: user.wiseEmail, accountHolder: user.wiseName };
        break;
      default: // bank
        hasInfo = !!(user.iban && user.bankName && user.accountHolder);
        paymentDetails = { iban: user.iban, bankName: user.bankName, accountHolder: user.accountHolder };
        break;
    }

    if (!hasInfo) {
      return res.status(400).json({ success: false, message: 'Önce ödeme bilgilerinizi kaydedin (Çekim sekmesi → Ödeme Bilgileri)' });
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
      bankName: method === 'bank' ? (user.bankName || '') : '',
      iban: method === 'bank' ? (user.iban || '') : '',
      accountHolder: paymentDetails.accountHolder || user.accountHolder || '',
      paymentMethod: method,
      paymentDetails,
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

// =============================================
// MAAŞ SİSTEMİ ENDPOINTLERİ
// =============================================

// GET /api/withdrawals/salary-history — Yayıncının maaş geçmişi
exports.getSalaryHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 12, 52);

    const history = await salaryService.getUserSalaryHistory(userId, limit);
    const nextPayment = salaryService.getNextPaymentInfo();

    res.json({
      success: true,
      salaryHistory: history.map(h => ({
        id: h._id,
        weekStart: h.weekStart,
        weekEnd: h.weekEnd,
        level: h.level,
        levelLabel: h.levelLabel,
        weeklyGifts: h.weeklyGifts,
        weeklyGiftsWithCalls: h.weeklyGiftsWithCalls,
        totalStreamingHours: h.totalStreamingHours,
        streamDaysCount: h.streamDaysCount,
        calculatedSalaryUSD: h.calculatedSalaryUSD,
        salaryCoins: h.salaryCoins,
        status: h.status,
        paidAt: h.paidAt,
        note: h.note,
        createdAt: h.createdAt,
      })),
      nextPayment: {
        currentWeekStart: nextPayment.currentWeekStart,
        currentWeekEnd: nextPayment.currentWeekEnd,
        nextPaymentDate: nextPayment.nextPaymentDate,
        daysUntilPayment: nextPayment.daysUntilPayment,
      },
    });
  } catch (err) {
    console.error("getSalaryHistory error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/withdrawals/admin/salary/process — Admin: Manuel maaş işleme tetikle
exports.adminProcessSalaries = async (req, res) => {
  try {
    const salaryCron = require("../jobs/salaryCron");
    const result = await salaryCron.runNow();

    if (result.error) {
      return res.status(400).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: "Haftalık maaş işleme tamamlandı",
      results: result.results,
    });
  } catch (err) {
    console.error("adminProcessSalaries error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/withdrawals/admin/salary/list — Admin: Tüm maaş ödemelerini listele
exports.adminListSalaries = async (req, res) => {
  try {
    const SalaryPayment = require("../models/SalaryPayment");
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const status = req.query.status; // paid, skipped, failed, calculated
    const weekStart = req.query.weekStart; // ISO date

    const filter = {};
    if (status) filter.status = status;
    if (weekStart) filter.weekStart = new Date(weekStart);

    const total = await SalaryPayment.countDocuments(filter);
    const salaries = await SalaryPayment.find(filter)
      .populate("user", "name username profileImage")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      salaries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("adminListSalaries error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// VİOLATION (İHLAL) YÖNETİMİ
// =============================================

// POST /api/withdrawals/admin/violations/:userId — Yayıncıya ihlal ekle
exports.adminAddViolation = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason, severity = "minor", penaltyPercent = 0, note = "", expiresAt } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: "İhlal sebebi gerekli" });
    }

    const validSeverities = ["warning", "minor", "major", "critical"];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({ success: false, message: "Geçersiz ihlal seviyesi" });
    }

    const penalty = Math.max(0, Math.min(Number(penaltyPercent) || 0, 100));

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const violation = {
      reason: reason.trim(),
      severity,
      penaltyPercent: penalty,
      issuedBy: req.user.id,
      issuedAt: new Date(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      active: true,
      note: (note || "").trim(),
    };

    user.violations.push(violation);
    await user.save();

    const addedViolation = user.violations[user.violations.length - 1];

    console.log(`[VIOLATION] Admin ${req.user.username} added violation to ${user.username}: ${reason} (${severity}, -%${penalty})`);

    res.json({
      success: true,
      message: "İhlal eklendi",
      violation: addedViolation,
    });
  } catch (err) {
    console.error("adminAddViolation error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/withdrawals/admin/violations/:userId — Yayıncının ihlallerini listele
exports.adminGetViolations = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select("violations name username").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Süresi dolmuş ihlalleri filtrele
    const now = new Date();
    const violations = (user.violations || []).map(v => ({
      ...v,
      active: v.active && (!v.expiresAt || new Date(v.expiresAt) > now),
    }));

    const activeCount = violations.filter(v => v.active).length;
    const totalPenalty = Math.min(
      violations.filter(v => v.active).reduce((sum, v) => sum + (v.penaltyPercent || 0), 0),
      100
    );

    res.json({
      success: true,
      userId,
      username: user.username,
      name: user.name,
      violations,
      activeCount,
      totalPenalty,
    });
  } catch (err) {
    console.error("adminGetViolations error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/withdrawals/admin/violations/:userId/:violationId — İhlali güncelle (deaktif et / düzenle)
exports.adminUpdateViolation = async (req, res) => {
  try {
    const { userId, violationId } = req.params;
    const { active, reason, severity, penaltyPercent, note, expiresAt } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const violation = user.violations.id(violationId);
    if (!violation) {
      return res.status(404).json({ success: false, message: "İhlal bulunamadı" });
    }

    if (typeof active === "boolean") violation.active = active;
    if (reason) violation.reason = reason.trim();
    if (severity) violation.severity = severity;
    if (penaltyPercent !== undefined) violation.penaltyPercent = Math.max(0, Math.min(Number(penaltyPercent), 100));
    if (note !== undefined) violation.note = (note || "").trim();
    if (expiresAt !== undefined) violation.expiresAt = expiresAt ? new Date(expiresAt) : null;

    await user.save();

    console.log(`[VIOLATION] Admin ${req.user.username} updated violation ${violationId} for ${user.username}: active=${violation.active}`);

    res.json({
      success: true,
      message: "İhlal güncellendi",
      violation,
    });
  } catch (err) {
    console.error("adminUpdateViolation error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/withdrawals/admin/violations/:userId/:violationId — İhlali sil
exports.adminDeleteViolation = async (req, res) => {
  try {
    const { userId, violationId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const violation = user.violations.id(violationId);
    if (!violation) {
      return res.status(404).json({ success: false, message: "İhlal bulunamadı" });
    }

    violation.deleteOne();
    await user.save();

    console.log(`[VIOLATION] Admin ${req.user.username} deleted violation ${violationId} for ${user.username}`);

    res.json({ success: true, message: "İhlal silindi" });
  } catch (err) {
    console.error("adminDeleteViolation error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/withdrawals/my-violations — Yayıncının kendi ihlallerini görmesi
exports.getMyViolations = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("violations").lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const now = new Date();
    const violations = (user.violations || []).map(v => ({
      _id: v._id,
      reason: v.reason,
      severity: v.severity,
      penaltyPercent: v.penaltyPercent,
      issuedAt: v.issuedAt,
      expiresAt: v.expiresAt,
      active: v.active && (!v.expiresAt || new Date(v.expiresAt) > now),
      note: v.note,
    }));

    const activeCount = violations.filter(v => v.active).length;
    const totalPenalty = Math.min(
      violations.filter(v => v.active).reduce((sum, v) => sum + (v.penaltyPercent || 0), 0),
      100
    );

    res.json({ success: true, violations, activeCount, totalPenalty });
  } catch (err) {
    console.error("getMyViolations error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
