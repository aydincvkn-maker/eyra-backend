// src/models/SalaryPayment.js
const mongoose = require("mongoose");

const salaryPaymentSchema = new mongoose.Schema(
  {
    // Kime ödendi
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Hafta aralığı (Pazartesi 00:00 → Pazar 23:59)
    weekStart: { type: Date, required: true },
    weekEnd: { type: Date, required: true },

    // Seviye bilgisi
    level: { type: Number, required: true, min: 1, max: 6 },
    levelLabel: { type: String },

    // Performans metrikleri
    weeklyGifts: { type: Number, default: 0 },         // Sadece hediye geliri (coin)
    weeklyGiftsWithCalls: { type: Number, default: 0 }, // Hediye + görüşme geliri (coin)
    totalStreamingMinutes: { type: Number, default: 0 }, // Toplam yayın süresi (dakika)
    totalStreamingHours: { type: Number, default: 0 },   // Toplam yayın süresi (saat, yuvarlanmış)
    streamDaysCount: { type: Number, default: 0 },       // Kaç gün yayın yapıldı

    // Maaş hesaplama
    salaryPerHour: { type: Number, default: 0 },   // Seviyeye göre saat başı $
    salaryPerDay: { type: Number, default: 0 },     // Seviyeye göre gün başı $
    salaryPerWeek: { type: Number, default: 0 },    // Seviyeye göre hafta başı $
    calculatedSalaryUSD: { type: Number, default: 0 }, // Hesaplanan maaş ($)
    salaryCoins: { type: Number, default: 0 },       // Coin olarak ödenen tutar

    // Durum
    status: {
      type: String,
      enum: [
        "calculated",  // Hesaplandı, ödeme bekliyor
        "paid",        // Coin hesaba eklendi
        "failed",      // Ödeme başarısız
        "skipped",     // Seviye 1, maaş yok
      ],
      default: "calculated",
    },

    // Ödeme bilgileri
    paidAt: { type: Date },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },

    // Hesaplama detayları (audit trail)
    calculationDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Not
    note: { type: String },
  },
  { timestamps: true }
);

// İndeksler
salaryPaymentSchema.index({ user: 1, weekStart: 1 }, { unique: true }); // Her kullanıcı için her hafta tek kayıt
salaryPaymentSchema.index({ user: 1, createdAt: -1 });
salaryPaymentSchema.index({ weekStart: 1, status: 1 });
salaryPaymentSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("SalaryPayment", salaryPaymentSchema);
