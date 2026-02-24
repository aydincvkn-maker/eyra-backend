// src/models/Withdrawal.js
const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // Çekim detayları
    amountCoins: { type: Number, required: true, min: 1 },       // Çekilecek coin miktarı
    amountUSD: { type: Number, required: true, min: 0 },         // Dolar karşılığı
    amountTRY: { type: Number, default: 0 },                     // TL karşılığı (opsiyonel)

    // Banka bilgileri
    bankName: { type: String, required: true },
    iban: { type: String, required: true },
    accountHolder: { type: String, required: true },              // Hesap sahibi adı

    // Durum
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid", "cancelled"],
      default: "pending",
      index: true,
    },

    // Admin işlemleri
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },                   // Admin notu
    rejectionReason: { type: String, default: "" },              // Red sebebi

    // Ödeme kanıtı
    paymentReference: { type: String, default: "" },             // Dekont/referans no
    paidAt: { type: Date, default: null },

    // Bakiye snapshot
    balanceBefore: { type: Number, default: 0 },                 // İşlem öncesi coin bakiye
    balanceAfter: { type: Number, default: 0 },                  // İşlem sonrası coin bakiye
  },
  { timestamps: true }
);

// İndeksler
withdrawalSchema.index({ user: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Withdrawal", withdrawalSchema);
