// src/models/SpinReward.js
const mongoose = require("mongoose");

const spinRewardSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },       // "100 Coin", "VIP 1 Gün", "Boş"
    labelEn: { type: String },
    type: {
      type: String,
      enum: ["coins", "xp", "vip_days", "gift", "nothing"],
      required: true,
    },
    value: { type: Number, default: 0 },            // Coin miktarı, XP miktarı, VIP gün sayısı
    probability: { type: Number, required: true },   // 0-100 arası olasılık
    color: { type: String, default: "#FFD700" },     // Çark dilim rengi
    icon: { type: String, default: "🎁" },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

spinRewardSchema.index({ isActive: 1, order: 1 });

module.exports = mongoose.model("SpinReward", spinRewardSchema);
