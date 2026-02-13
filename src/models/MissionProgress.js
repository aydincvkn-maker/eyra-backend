// src/models/MissionProgress.js
const mongoose = require("mongoose");

const missionProgressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    mission: { type: mongoose.Schema.Types.ObjectId, ref: "Mission", required: true },
    missionKey: { type: String, required: true },

    // İlerleme
    currentCount: { type: Number, default: 0 },
    targetCount: { type: Number, default: 1 },
    isCompleted: { type: Boolean, default: false },
    isRewardClaimed: { type: Boolean, default: false },

    // Tarihler
    completedAt: { type: Date, default: null },
    rewardClaimedAt: { type: Date, default: null },

    // Günlük/haftalık görev resetleme
    periodStart: { type: Date, required: true }, // Dönem başlangıcı
    periodEnd: { type: Date, required: true },   // Dönem sonu
  },
  { timestamps: true }
);

// Aynı kullanıcı + görev + dönem kombinasyonu unique
missionProgressSchema.index({ user: 1, mission: 1, periodStart: 1 }, { unique: true });
missionProgressSchema.index({ user: 1, isCompleted: 1 });
missionProgressSchema.index({ periodEnd: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }); // 7 gün sonra sil

module.exports = mongoose.model("MissionProgress", missionProgressSchema);
