// src/models/CallHistory.js
const mongoose = require("mongoose");

const callHistorySchema = new mongoose.Schema(
  {
    // Aramayı başlatan
    caller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Aranan kişi
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Arama tipi
    type: { type: String, enum: ["video", "audio", "paid_video"], default: "video" },
    // Durum
    status: { type: String, enum: ["completed", "missed", "rejected", "cancelled"], default: "completed" },
    // Süre (saniye)
    durationSec: { type: Number, default: 0 },
    // Coin ücreti (ücretli aramalar için)
    coinCost: { type: Number, default: 0 },
    // Oda adı
    roomName: { type: String, default: "" },
    // Başlama ve bitiş zamanı
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

callHistorySchema.index({ caller: 1, createdAt: -1 });
callHistorySchema.index({ receiver: 1, createdAt: -1 });

module.exports = mongoose.model("CallHistory", callHistorySchema);
