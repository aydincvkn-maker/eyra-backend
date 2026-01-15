// src/models/Gift.js
const mongoose = require("mongoose");

const giftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String },
    valueCoins: { type: Number, required: true, min: 1 },
    animationUrl: { type: String }, // özel animasyon varsa
    
    // Yönetim
    isActive: { type: Boolean, default: true },
    category: { type: String, default: "general" },
    order: { type: Number, default: 0 }, // sıralama için
    
    // İstatistikler
    totalSent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Gift", giftSchema);