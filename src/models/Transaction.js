// src/models/Transaction.js
const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    
    // İşlem tipi
    type: {
      type: String,
      enum: [
        "gift_sent",        // Hediye gönderme (coin düşer)
        "gift_received",    // Hediye alma (coin artar)
        "call_payment",     // Ücretli arama ödemesi
        "call_earning",     // Ücretli arama kazancı
        "spin_reward",      // Çark ödülü
        "mission_reward",   // Görev ödülü
        "daily_bonus",      // Günlük giriş bonusu
        "admin_grant",      // Admin tarafından verilen coin
        "admin_deduct",     // Admin tarafından düşülen coin
        "vip_purchase",     // VIP satın alma
        "purchase",         // Uygulama içi satın alma
        "refund",           // İade
        "achievement_reward", // Başarım ödülü
        "level_up_bonus",   // Seviye atlama bonusu
      ],
      required: true,
    },
    
    // Tutar
    amount: { type: Number, required: true }, // Pozitif = kazanç, negatif = harcama
    balanceAfter: { type: Number }, // İşlem sonrası bakiye
    
    // İlişkiler
    relatedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Hediye gönderen/alan
    relatedGift: { type: mongoose.Schema.Types.ObjectId, ref: "Gift" },
    relatedStream: { type: mongoose.Schema.Types.ObjectId, ref: "LiveStream" },
    relatedCall: { type: mongoose.Schema.Types.ObjectId, ref: "CallHistory" },
    relatedMission: { type: mongoose.Schema.Types.ObjectId, ref: "Mission" },
    
    // Detay
    description: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed }, // Ek bilgi
    
    // Durum
    status: {
      type: String,
      enum: ["completed", "pending", "failed", "reversed"],
      default: "completed",
    },
  },
  { timestamps: true }
);

// İndeksler
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ user: 1, type: 1, createdAt: -1 });
transactionSchema.index({ status: 1 });

module.exports = mongoose.model("Transaction", transactionSchema);
