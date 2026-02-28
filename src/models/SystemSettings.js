const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
  {
    // Mevcut
    maintenanceMode: { type: Boolean, default: false },
    globalSlowMode: { type: Boolean, default: false },
    
    // Yeni genel ayarlar
    minAppVersion: { type: String, default: "1.0.0" },
    maxLoginAttempts: { type: Number, default: 5 },
    registrationEnabled: { type: Boolean, default: true },
    guestLoginEnabled: { type: Boolean, default: true },
    
    // Coin ekonomisi
    defaultCoins: { type: Number, default: 1000 },
    giftCommissionPercent: { type: Number, default: 55 }, // Platform komisyonu %
    dailyLoginBonus: { type: Number, default: 50 },
    
    // Spin ayarları
    spinEnabled: { type: Boolean, default: true },
    dailySpinLimit: { type: Number, default: 1 },
    vipDailySpinLimit: { type: Number, default: 2 },
    
    // Arama ayarları
    defaultCallPrice: { type: Number, default: 100 },
    minCallPrice: { type: Number, default: 50 },
    maxCallPrice: { type: Number, default: 1000 },
    
    // Moderasyon
    autoModerationEnabled: { type: Boolean, default: false },
    maxReportsBeforeAutoBan: { type: Number, default: 10 },
    
    // VIP
    vipSilverPrice: { type: Number, default: 5000 },
    vipGoldPrice: { type: Number, default: 15000 },
    vipDiamondPrice: { type: Number, default: 50000 },
    vipSilverDays: { type: Number, default: 30 },
    vipGoldDays: { type: Number, default: 30 },
    vipDiamondDays: { type: Number, default: 30 },
    
    // Bildirimler
    pushNotificationsEnabled: { type: Boolean, default: true },
    
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SystemSettings", systemSettingsSchema);
