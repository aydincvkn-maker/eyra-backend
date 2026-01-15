// src/models/Gift.js
const mongoose = require("mongoose");

const giftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String, required: true },
    animationUrl: { type: String },
    valueCoins: { type: Number, required: true, min: 1 },
    
    // Yönetim
    isActive: { type: Boolean, default: true },
    category: { 
      type: String, 
      enum: ["basic", "premium", "vip", "special"],
      default: "basic" 
    },
    order: { type: Number, default: 0 },
    
    // İstatistikler
    totalSent: { type: Number, default: 0 },
    totalCoinsSpent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Index for faster queries
giftSchema.index({ isActive: 1, category: 1, order: 1 });

module.exports = mongoose.model("Gift", giftSchema);
