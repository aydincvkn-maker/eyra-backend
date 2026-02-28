// src/services/salaryService.js
/**
 * Haftalık Maaş Ödeme Servisi
 *
 * Akış:
 *  1. Her Pazartesi 00:05'te cron tetiklenir
 *  2. Geçen haftanın (Pazartesi 00:00 → Pazar 23:59:59) performansı hesaplanır
 *  3. Her aktif yayıncı için:
 *     a. Haftalık hediye geliri ve hediye+görüşme geliri hesaplanır
 *     b. Yayın süreleri toplanır (LiveStream.duration)
 *     c. Seviye belirlenir
 *     d. Maaş coin olarak hesaba eklenir
 *     e. Transaction ve SalaryPayment kaydı oluşturulur
 */

const mongoose = require("mongoose");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const LiveStream = require("../models/LiveStream");
const SalaryPayment = require("../models/SalaryPayment");

// =============================================
// SABITLER (withdrawalController ile aynı)
// =============================================
const COIN_TO_USD_RATE = 0.01; // 1 coin = $0.01

const HOST_SALARY_LEVELS = [
  {
    level: 1, minGifts: 0, maxGifts: 34999,
    minGiftsWithCalls: 0, maxGiftsWithCalls: 34999,
    salaryPerHour: 0, salaryPerDay: 0,
    hoursPerDayLabel: "-", salaryPerWeek: 0,
    salaryType: "none", label: "Seviye 1",
    description: "Başlangıç seviyesi",
    maxHoursPerDay: 0,
  },
  {
    level: 2, minGifts: 35000, maxGifts: 69999,
    minGiftsWithCalls: 35000, maxGiftsWithCalls: 99999,
    salaryPerHour: 0, salaryPerDay: 5,
    hoursPerDayLabel: "2 Saat/gün", salaryPerWeek: 35,
    salaryType: "daily", label: "Seviye 2",
    description: "$5/Gün • 2 Saat/gün • $35/Hafta",
    maxHoursPerDay: 2,
  },
  {
    level: 3, minGifts: 70000, maxGifts: 174999,
    minGiftsWithCalls: 100000, maxGiftsWithCalls: 209999,
    salaryPerHour: 5, salaryPerDay: 10,
    hoursPerDayLabel: "2 Saat/gün", salaryPerWeek: 70,
    salaryType: "hourly", label: "Seviye 3",
    description: "$5/Saat • 2 Saat/gün • $70/Hafta",
    maxHoursPerDay: 2,
  },
  {
    level: 4, minGifts: 175000, maxGifts: 209999,
    minGiftsWithCalls: 210000, maxGiftsWithCalls: 299999,
    salaryPerHour: 6, salaryPerDay: 18,
    hoursPerDayLabel: "2-3 Saat/gün", salaryPerWeek: 126,
    salaryType: "hourly", label: "Seviye 4",
    description: "$6/Saat • 2-3 Saat/gün • $126/Hafta",
    maxHoursPerDay: 3,
  },
  {
    level: 5, minGifts: 210000, maxGifts: 499999,
    minGiftsWithCalls: 300000, maxGiftsWithCalls: 499999,
    salaryPerHour: 7, salaryPerDay: 21,
    hoursPerDayLabel: "2-3 Saat/gün", salaryPerWeek: 147,
    salaryType: "hourly", label: "Seviye 5",
    description: "$7/Saat • 2-3 Saat/gün • $147/Hafta",
    maxHoursPerDay: 3,
  },
  {
    level: 6, minGifts: 500000, maxGifts: Infinity,
    minGiftsWithCalls: 500000, maxGiftsWithCalls: Infinity,
    salaryPerHour: 10, salaryPerDay: 30,
    hoursPerDayLabel: "2-3 Saat/gün", salaryPerWeek: 210,
    salaryType: "hourly", label: "Seviye 6",
    description: "$10/Saat • 2-3 Saat/gün • $210/Hafta",
    maxHoursPerDay: 3,
  },
];

/**
 * Seviye hesapla — ikisinden yüksek olanı baz alır
 */
function calculateHostLevel(weeklyGifts, weeklyGiftsWithCalls) {
  let bestLevel = HOST_SALARY_LEVELS[0];
  for (const lvl of HOST_SALARY_LEVELS) {
    const meetsGift = weeklyGifts >= lvl.minGifts;
    const meetsCall = weeklyGiftsWithCalls >= lvl.minGiftsWithCalls;
    if (meetsGift || meetsCall) bestLevel = lvl;
  }
  return bestLevel;
}

/**
 * Geçen haftanın tarih aralığını hesapla (Pazartesi 00:00 → Pazar 23:59:59.999)
 * @param {Date} [referenceDate] - Varsayılan: şimdi. Test için farklı tarih verilebilir.
 * @returns {{ weekStart: Date, weekEnd: Date }}
 */
function getLastWeekRange(referenceDate = new Date()) {
  const now = new Date(referenceDate);

  // Bu haftanın Pazartesi'sini bul
  const dayOfWeek = now.getUTCDay(); // 0=Pazar, 1=Pazartesi ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  thisMonday.setUTCHours(0, 0, 0, 0);

  // Geçen haftanın Pazartesi'si
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);

  // Geçen haftanın Pazar'ı 23:59:59.999
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCMilliseconds(lastSunday.getUTCMilliseconds() - 1);

  return { weekStart: lastMonday, weekEnd: lastSunday };
}

/**
 * Bu haftanın tarih aralığını hesapla (güncel hafta, Pazartesi 00:00 → şu an)
 * Yayıncı bilgi ekranında mevcut ilerlemeyi göstermek için.
 */
function getCurrentWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  thisMonday.setUTCHours(0, 0, 0, 0);

  // Bu Pazar 23:59:59.999
  const thisSunday = new Date(thisMonday);
  thisSunday.setUTCDate(thisMonday.getUTCDate() + 6);
  thisSunday.setUTCHours(23, 59, 59, 999);

  return { weekStart: thisMonday, weekEnd: thisSunday };
}

/**
 * Belirli bir kullanıcının belirli hafta performansını hesapla
 */
async function calculateWeeklyPerformance(userId, weekStart, weekEnd) {
  const userObjectId = typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  // 1. Haftalık hediye geliri (sadece gift_received)
  const giftAgg = await Transaction.aggregate([
    {
      $match: {
        user: userObjectId,
        type: "gift_received",
        status: "completed",
        createdAt: { $gte: weekStart, $lte: weekEnd },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const weeklyGifts = giftAgg[0]?.total || 0;

  // 2. Haftalık hediye + görüşme geliri
  const totalAgg = await Transaction.aggregate([
    {
      $match: {
        user: userObjectId,
        type: { $in: ["gift_received", "call_earning", "paid_call_earning"] },
        status: "completed",
        createdAt: { $gte: weekStart, $lte: weekEnd },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const weeklyGiftsWithCalls = totalAgg[0]?.total || 0;

  // 3. Yayın süresi hesapla (LiveStream.duration saniye cinsinden)
  const streamAgg = await LiveStream.aggregate([
    {
      $match: {
        host: userObjectId,
        status: "ended",
        startedAt: { $gte: weekStart, $lte: weekEnd },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$startedAt", timezone: "UTC" } },
        totalDuration: { $sum: "$duration" }, // saniye
        streamCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  let totalStreamingMinutes = 0;
  let streamDaysCount = 0;
  const dailyStreaming = [];

  for (const day of streamAgg) {
    const dayMinutes = Math.floor(day.totalDuration / 60);
    totalStreamingMinutes += dayMinutes;
    streamDaysCount++;
    dailyStreaming.push({
      date: day._id,
      minutes: dayMinutes,
      hours: Math.round((dayMinutes / 60) * 100) / 100,
      streamCount: day.streamCount,
    });
  }

  const totalStreamingHours = Math.round((totalStreamingMinutes / 60) * 100) / 100;

  return {
    weeklyGifts,
    weeklyGiftsWithCalls,
    totalStreamingMinutes,
    totalStreamingHours,
    streamDaysCount,
    dailyStreaming,
  };
}

/**
 * Maaş hesapla — seviyeye göre
 *
 * Seviye 1: Maaş yok
 * Seviye 2: Günde $5 (sabit, yayın yapılan gün başına)
 * Seviye 3-6: Saat başı ücret × günlük max saat × yayın yapılan gün sayısı
 *
 * Günlük yayın saati, seviyenin maxHoursPerDay'ine göre cap'lenir.
 * Örnek: Seviye 3 — $5/saat, 2 saat/gün cap. 5 gün yayın → 5×2×$5 = $50
 *         Ama haftalık max $70 ile sınırlandırılır.
 */
function calculateSalary(levelData, performance) {
  if (levelData.level === 1) {
    return { salaryUSD: 0, salaryCoins: 0, method: "none" };
  }

  let salaryUSD = 0;
  let method = "";

  if (levelData.salaryType === "daily") {
    // Seviye 2: Yayın yapılan gün × günlük ücret
    // Minimum 30 dakika yayın yapılmış günler sayılır (kötüye kullanım önlemi)
    const MIN_STREAM_MINUTES_PER_DAY = 30;
    const eligibleDays = performance.dailyStreaming.filter(
      (d) => d.minutes >= MIN_STREAM_MINUTES_PER_DAY
    ).length;
    salaryUSD = Math.min(eligibleDays, 7) * levelData.salaryPerDay;
    method = `${eligibleDays} gün × $${levelData.salaryPerDay}/gün (min ${MIN_STREAM_MINUTES_PER_DAY}dk/gün)`;
  } else if (levelData.salaryType === "hourly") {
    // Seviye 3-6: Her gün için min(gerçek saat, maxHoursPerDay) × saatlik ücret
    let totalEligibleHours = 0;
    for (const day of performance.dailyStreaming) {
      const cappedHours = Math.min(day.hours, levelData.maxHoursPerDay);
      totalEligibleHours += cappedHours;
    }
    // Toplam saatleri 0.5 saat hassasiyetinde yuvarla (aşağı)
    totalEligibleHours = Math.floor(totalEligibleHours * 2) / 2;
    salaryUSD = totalEligibleHours * levelData.salaryPerHour;
    method = `${totalEligibleHours} saat × $${levelData.salaryPerHour}/saat`;
  }

  // Haftalık maksimum ile sınırlandır
  salaryUSD = Math.min(salaryUSD, levelData.salaryPerWeek);
  salaryUSD = Math.round(salaryUSD * 100) / 100;

  // USD → Coin dönüşümü (1 coin = $0.01, yani $1 = 100 coin)
  const salaryCoins = Math.round(salaryUSD / COIN_TO_USD_RATE);

  return { salaryUSD, salaryCoins, method };
}

/**
 * Tek bir yayıncı için haftalık maaş işle
 */
async function processUserWeeklySalary(userId, weekStart, weekEnd) {
  const userObjectId = typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  // Zaten bu hafta için ödeme yapılmış mı kontrol et
  const existing = await SalaryPayment.findOne({
    user: userObjectId,
    weekStart,
  });

  if (existing) {
    return { skipped: true, reason: "already_processed", existing };
  }

  // Performans hesapla
  const performance = await calculateWeeklyPerformance(userId, weekStart, weekEnd);

  // Seviye belirle
  const levelData = calculateHostLevel(performance.weeklyGifts, performance.weeklyGiftsWithCalls);

  // Maaş hesapla
  const { salaryUSD, salaryCoins, method } = calculateSalary(levelData, performance);

  // SalaryPayment kaydı oluştur
  const salaryPayment = new SalaryPayment({
    user: userObjectId,
    weekStart,
    weekEnd,
    level: levelData.level,
    levelLabel: levelData.label,
    weeklyGifts: performance.weeklyGifts,
    weeklyGiftsWithCalls: performance.weeklyGiftsWithCalls,
    totalStreamingMinutes: performance.totalStreamingMinutes,
    totalStreamingHours: performance.totalStreamingHours,
    streamDaysCount: performance.streamDaysCount,
    salaryPerHour: levelData.salaryPerHour,
    salaryPerDay: levelData.salaryPerDay,
    salaryPerWeek: levelData.salaryPerWeek,
    calculatedSalaryUSD: salaryUSD,
    salaryCoins,
    status: levelData.level === 1 ? "skipped" : "calculated",
    calculationDetails: {
      method,
      dailyStreaming: performance.dailyStreaming,
      levelData: {
        level: levelData.level,
        salaryType: levelData.salaryType,
        maxHoursPerDay: levelData.maxHoursPerDay,
      },
    },
  });

  // Seviye 1 → maaş yok, sadece kayıt oluştur
  if (levelData.level === 1) {
    salaryPayment.status = "skipped";
    salaryPayment.note = "Seviye 1 - maaş hak edilmedi";
    await salaryPayment.save();
    return { skipped: true, reason: "level_1", salaryPayment };
  }

  // Maaş 0 → (yayın yapmamış olabilir)
  if (salaryCoins <= 0) {
    salaryPayment.status = "skipped";
    salaryPayment.note = "Maaş $0 — yeterli yayın yapılmadı";
    await salaryPayment.save();
    return { skipped: true, reason: "zero_salary", salaryPayment };
  }

  // Coin'i kullanıcının hesabına ekle
  try {
    const user = await User.findById(userObjectId);
    if (!user) {
      salaryPayment.status = "failed";
      salaryPayment.note = "Kullanıcı bulunamadı";
      await salaryPayment.save();
      return { error: true, reason: "user_not_found" };
    }

    // Coin ekle
    user.coins += salaryCoins;
    user.totalEarnings += salaryCoins;
    await user.save();

    // Transaction kaydı oluştur
    const transaction = new Transaction({
      user: userObjectId,
      type: "salary_payment",
      amount: salaryCoins,
      balanceAfter: user.coins,
      description: `Haftalık maaş ödemesi — ${levelData.label} ($${salaryUSD})`,
      metadata: {
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        level: levelData.level,
        salaryUSD,
        method,
      },
      status: "completed",
    });
    await transaction.save();

    // SalaryPayment güncelle
    salaryPayment.status = "paid";
    salaryPayment.paidAt = new Date();
    salaryPayment.transactionId = transaction._id;
    await salaryPayment.save();

    return {
      success: true,
      salaryPayment,
      salaryUSD,
      salaryCoins,
      level: levelData.level,
    };
  } catch (err) {
    salaryPayment.status = "failed";
    salaryPayment.note = `Ödeme hatası: ${err.message}`;
    await salaryPayment.save();
    return { error: true, reason: err.message, salaryPayment };
  }
}

/**
 * Tüm aktif yayıncılar için haftalık maaş işle
 * Her Pazartesi cron tarafından çağrılır.
 */
async function processAllWeeklySalaries(referenceDate) {
  const { weekStart, weekEnd } = getLastWeekRange(referenceDate);

  console.log(`[SALARY] ═══════════════════════════════════════════════`);
  console.log(`[SALARY] Haftalık maaş işleme başlıyor`);
  console.log(`[SALARY] Hafta: ${weekStart.toISOString()} → ${weekEnd.toISOString()}`);

  // Sözleşmesi imzalanmış, kadın yayıncıları bul
  const broadcasters = await User.find({
    gender: "female",
    "broadcasterContract.signed": true,
  }).select("_id name username");

  console.log(`[SALARY] ${broadcasters.length} aktif yayıncı bulundu`);

  const results = {
    total: broadcasters.length,
    paid: 0,
    skipped: 0,
    failed: 0,
    totalCoins: 0,
    totalUSD: 0,
    details: [],
  };

  for (const broadcaster of broadcasters) {
    try {
      const result = await processUserWeeklySalary(
        broadcaster._id,
        weekStart,
        weekEnd
      );

      if (result.success) {
        results.paid++;
        results.totalCoins += result.salaryCoins;
        results.totalUSD += result.salaryUSD;
        results.details.push({
          userId: broadcaster._id,
          username: broadcaster.username,
          status: "paid",
          level: result.level,
          salaryUSD: result.salaryUSD,
          salaryCoins: result.salaryCoins,
        });
        console.log(`[SALARY] ✓ ${broadcaster.username}: Seviye ${result.level}, $${result.salaryUSD} (${result.salaryCoins} coin)`);
      } else if (result.skipped) {
        results.skipped++;
        results.details.push({
          userId: broadcaster._id,
          username: broadcaster.username,
          status: "skipped",
          reason: result.reason,
        });
        console.log(`[SALARY] ○ ${broadcaster.username}: Atlandı (${result.reason})`);
      } else if (result.error) {
        results.failed++;
        results.details.push({
          userId: broadcaster._id,
          username: broadcaster.username,
          status: "failed",
          reason: result.reason,
        });
        console.log(`[SALARY] ✗ ${broadcaster.username}: Hata (${result.reason})`);
      }
    } catch (err) {
      results.failed++;
      results.details.push({
        userId: broadcaster._id,
        username: broadcaster.username,
        status: "error",
        reason: err.message,
      });
      console.error(`[SALARY] ✗ ${broadcaster.username}: Exception`, err.message);
    }
  }

  console.log(`[SALARY] ───────────────────────────────────────────────`);
  console.log(`[SALARY] Sonuç: ${results.paid} ödendi, ${results.skipped} atlandı, ${results.failed} başarısız`);
  console.log(`[SALARY] Toplam: $${results.totalUSD} (${results.totalCoins} coin)`);
  console.log(`[SALARY] ═══════════════════════════════════════════════`);

  return results;
}

/**
 * Kullanıcının maaş geçmişini getir
 */
async function getUserSalaryHistory(userId, limit = 12) {
  return SalaryPayment.find({ user: userId })
    .sort({ weekStart: -1 })
    .limit(limit)
    .lean();
}

/**
 * Kullanıcının sonraki maaş ödeme bilgisini getir
 */
function getNextPaymentInfo() {
  const { weekStart, weekEnd } = getCurrentWeekRange();

  // Sonraki pazartesi
  const nextMonday = new Date(weekEnd);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 1);
  nextMonday.setUTCHours(0, 5, 0, 0); // Pazartesi 00:05

  return {
    currentWeekStart: weekStart,
    currentWeekEnd: weekEnd,
    nextPaymentDate: nextMonday,
    daysUntilPayment: Math.ceil((nextMonday.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
  };
}

module.exports = {
  HOST_SALARY_LEVELS,
  calculateHostLevel,
  getLastWeekRange,
  getCurrentWeekRange,
  calculateWeeklyPerformance,
  calculateSalary,
  processUserWeeklySalary,
  processAllWeeklySalaries,
  getUserSalaryHistory,
  getNextPaymentInfo,
};
