// src/models/Mission.js
const mongoose = require("mongoose");

const missionSchema = new mongoose.Schema(
  {
    // Görev tanımı
    key: { type: String, required: true, unique: true }, // 'daily_login', 'send_gift', 'watch_stream' vb.
    title: { type: String, required: true },
    titleEn: { type: String },
    description: { type: String, required: true },
    descriptionEn: { type: String },
    icon: { type: String, default: "🎯" },

    // Görev tipi
    type: {
      type: String,
      enum: ["daily", "weekly", "one_time", "milestone"],
      default: "daily",
    },
    category: {
      type: String,
      enum: ["social", "streaming", "gifting", "engagement", "milestone"],
      default: "engagement",
    },

    // Hedef ve ödül
    targetCount: { type: Number, default: 1 }, // Kaç kez yapılmalı
    rewardCoins: { type: Number, default: 0 },
    rewardXP: { type: Number, default: 0 },

    // Sıralama ve durum
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

missionSchema.index({ type: 1, isActive: 1, order: 1 });

module.exports = mongoose.model("Mission", missionSchema);
