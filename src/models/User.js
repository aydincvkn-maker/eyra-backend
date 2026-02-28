// src/models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const BCRYPT_ROUNDS = 10;

const isBcryptHash = (value) => {
  if (typeof value !== "string") return false;
  // bcrypt hashes start with $2a$, $2b$, or $2y$
  return value.startsWith("$2a$") || value.startsWith("$2b$") || value.startsWith("$2y$");
};

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },

    role: {
      type: String,
      enum: ["super_admin", "moderator", "viewer", "admin"],
      default: "viewer"
    },

    permissions: [{
      type: String,
      enum: [
        'streams:view', 'streams:edit', 'streams:ban',
        'users:view', 'users:edit', 'users:ban',
        'reports:view', 'reports:manage',
        'finance:view',
        'system:settings'
      ]
    }],

    // COIN VE SEVİYE
    coins: { type: Number, default: 1000, min: 0 },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },

    // ÜCRETLI ARAMA AYARLARI
    callPricePerMinute: { type: Number, default: 100 }, // Dakika başı coin
    preferredLanguage: { type: String, default: 'tr' }, // Tercih edilen dil

    // PROFİL BİLGİLERİ
    profileImage: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 500 },
    gender: { type: String, enum: ["male", "female", "other"], default: "female" },
    age: { type: Number, default: 20 },
    location: { type: String, default: "Türkiye" },
    country: { type: String, default: "TR" },

    // SOSYAL İSTATİSTİKLER
    followers: { type: Number, default: 0 },
    following: { type: Number, default: 0 },
    gifts: { type: Number, default: 0 },

    // DURUM
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    isLive: { type: Boolean, default: false },
    isBusy: { type: Boolean, default: false },
    presenceStatus: { type: String, enum: ["online", "offline", "live", "in_call"], default: "offline" },

    // Presence zaman damgaları (gerçek online/busy/offline)
    lastOnlineAt: { type: Date, default: null },
    lastOfflineAt: { type: Date, default: null },
    busyUntil: { type: Date, default: null },

    // HESAP DURUMU
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isBanned: { type: Boolean, default: false },
    isFrozen: { type: Boolean, default: false },
    isGuest: { type: Boolean, default: false },

    // AYARLAR
    settings: {
      pushNotifications: { type: Boolean, default: true },
      messageNotifications: { type: Boolean, default: true },
      callNotifications: { type: Boolean, default: true },
      visitorNotifications: { type: Boolean, default: true },
      followNotifications: { type: Boolean, default: true },
      giftNotifications: { type: Boolean, default: true },
      emailNotifications: { type: Boolean, default: false },
      smsAlerts: { type: Boolean, default: false },
      soundEffects: { type: Boolean, default: true },
      showOnlineStatus: { type: Boolean, default: true },
      profileVisibility: { type: Boolean, default: true },
      allowMessages: { type: Boolean, default: true },
      showActivity: { type: Boolean, default: false }
    },

    // ENGELLENEN KULLANICILAR
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // VIP SİSTEMİ
    isVip: { type: Boolean, default: false },
    vipTier: { type: String, enum: ['none', 'silver', 'gold', 'diamond'], default: 'none' },
    vipExpiresAt: { type: Date, default: null },
    vipPurchasedAt: { type: Date, default: null },

    // YAYINCI BİLGİLERİ (Kadın kullanıcılar)
    broadcasterContract: {
      signed: { type: Boolean, default: false },
      signedAt: { type: Date, default: null },
      ipAddress: { type: String, default: "" },
      userAgent: { type: String, default: "" },
      version: { type: String, default: "" },
    },
    iban: { type: String, default: null },
    bankName: { type: String, default: null },
    accountHolder: { type: String, default: null },

    // PUSH BİLDİRİMLER
    fcmToken: { type: String, default: null },
    fcmTokenUpdatedAt: { type: Date, default: null },

    // PROFİL DOĞRULAMA
    verificationStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    verificationPhoto: { type: String, default: null },
    verificationRequestedAt: { type: Date, default: null },
    verificationReviewedAt: { type: Date, default: null },
    verificationReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // BAŞARIMLAR
    achievements: [{
      id: String,
      name: String,
      icon: String,
      description: String,
      category: { type: String, enum: ['social', 'streaming', 'gifting', 'milestone'] },
      unlockedAt: Date
    }],

    // XP EVENT TRACKING
    dailyXpEarned: { type: Number, default: 0 },
    dailyXpResetAt: { type: Date, default: null },
    totalXpEarned: { type: Number, default: 0 },

    // GÜNLÜK GÖREVLER
    dailyMissionsCompletedAt: { type: Date, default: null },
    spinLastUsedAt: { type: Date, default: null },
    dailyLoginAt: { type: Date, default: null },
    loginStreak: { type: Number, default: 0 },

    // TOKEN
    refreshToken: { type: String, default: null }
  },
  { timestamps: true }
);

// Hash password on create/update.
// Backward compatible: if old users have plaintext passwords, they will be
// upgraded on next successful login (see authController).
userSchema.pre("save", async function () {
  if (!this.isModified("password")) {
    return;
  }

  const raw = String(this.password || "");
  if (!raw) {
    return;
  }

  if (isBcryptHash(raw)) {
    return;
  }

  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  this.password = await bcrypt.hash(raw, salt);
});

// Şifre karşılaştırma
userSchema.methods.comparePassword = async function (candidatePassword) {
  const cleanPassword = String(candidatePassword || "").trim();
  const stored = String(this.password || "");

  // New accounts: bcrypt
  if (isBcryptHash(stored)) {
    return bcrypt.compare(cleanPassword, stored);
  }

  // Legacy accounts: plaintext compare
  return cleanPassword === stored;
};

userSchema.methods.isPasswordHashed = function () {
  return isBcryptHash(String(this.password || ""));
};

// Seviye hesaplama
userSchema.methods.calculateLevel = function() {
  const xpThresholds = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500];
  for (let i = xpThresholds.length - 1; i >= 0; i--) {
    if (this.xp >= xpThresholds[i]) {
      return i + 1;
    }
  }
  return 1;
};

// XP ekleme
userSchema.methods.addXP = async function(amount) {
  this.xp += amount;
  const oldLevel = this.level;
  this.level = this.calculateLevel();
  await this.save();

  // ✅ Level-up achievement trigger (lazy require to avoid circular deps)
  if (this.level > oldLevel) {
    try {
      const { checkLevelAchievements } = require("../controllers/achievementController");
      await checkLevelAchievements(this._id, this.level);
    } catch (e) {
      console.warn("⚠️ Level achievement check failed:", e.message);
    }
  }
};

// ✅ İndeksler - Çevrimiçi/çevrimdışı sorgularını hızlandır
userSchema.index({ isOnline: 1, gender: 1 });
userSchema.index({ isLive: 1 });
userSchema.index({ isBusy: 1 });
userSchema.index({ lastOnlineAt: 1 });
userSchema.index({ lastOfflineAt: 1 });
// username zaten unique: true olarak schema'da tanımlı, duplicate index ekleme

module.exports = mongoose.model("User", userSchema);