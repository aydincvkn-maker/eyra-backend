const mongoose = require("mongoose");

// ✅ Co-host schema (yayına katılan diğer yayıncılar)
const coHostSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: { 
    type: String, 
    enum: ["co-host", "guest", "moderator"],
    default: "guest"
  },
  joinedAt: { type: Date, default: Date.now },
  canPublish: { type: Boolean, default: true },     // Video/ses paylaşabilir mi
  canModerate: { type: Boolean, default: false },   // Chat moderasyonu yapabilir mi
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected", "left"],
    default: "pending"
  }
}, { _id: true });

const liveStreamSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    category: { 
      type: String, 
      enum: ["chat", "music", "dance", "talk", "gaming", "other"],
      default: "chat" 
    },
    thumbnailUrl: { type: String },

    // Yayın Durumu
    isLive: { type: Boolean, default: true, index: true },
    status: { 
      type: String, 
      enum: ["live", "ended", "flagged", "banned"], 
      default: "live",
      index: true 
    },
    
    // ✅ Stream Quality Settings
    quality: {
      type: String,
      enum: ["low", "medium", "high", "auto"],
      default: "auto"
    },
    resolution: {
      type: String,
      enum: ["480p", "720p", "1080p"],
      default: "720p"
    },
    bitrate: { type: Number, default: 2000 }, // kbps
    
    // ✅ Co-host Support (birden fazla yayıncı)
    coHosts: [coHostSchema],
    maxCoHosts: { type: Number, default: 3 },  // Maksimum co-host sayısı
    allowCoHostRequests: { type: Boolean, default: true }, // Co-host isteklerine açık mı
    
    // İzleyiciler
    viewerCount: { type: Number, default: 0 },
    peakViewerCount: { type: Number, default: 0 },
    viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    
    // Hediyeler ve Kazanç
    totalGiftsValue: { type: Number, default: 0 },
    totalGiftsCount: { type: Number, default: 0 },
    
    // Moderasyon
    isFlagged: { type: Boolean, default: false },
    flagReason: { type: String },
    bannedAt: { type: Date },
    
    // Platform Bilgisi
    roomId: { type: String, required: true, unique: true, index: true },
    platform: { type: String, default: "Mobile" },
    coinsPerMin: { type: Number, default: 0 },
    
    // Zamanlar
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    duration: { type: Number, default: 0 }, // saniye cinsinden
  },
  { timestamps: true }
);

// Compound indexes for common queries
liveStreamSchema.index({ isLive: 1, status: 1, createdAt: -1 });
liveStreamSchema.index({ host: 1, isLive: 1 });
liveStreamSchema.index({ isLive: 1, status: 1, category: 1, viewerCount: -1 }); // ✅ Kategori + sıralama
liveStreamSchema.index({ host: 1, status: 1, endedAt: -1 }); // ✅ Kullanıcı geçmişi
liveStreamSchema.index({ status: 1, startedAt: -1 }); // ✅ Admin listeleme
liveStreamSchema.index({ isFlagged: 1, status: 1 }); // ✅ Moderasyon

// ✅ OPTIMIZED: Peak viewer count sadece viewerCount değiştiğinde güncellenir
// $max operatörü controller'da kullanılıyor - pre-save hook artık gereksiz
liveStreamSchema.pre('save', function() {
  // Peak viewer count otomatik güncelleme (fallback)
  if (this.isModified('viewerCount') && this.viewerCount > this.peakViewerCount) {
    this.peakViewerCount = this.viewerCount;
  }
});

// Pre-save: duration hesapla
liveStreamSchema.pre('save', function() {
  if (this.endedAt && this.startedAt) {
    this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
  }
});

module.exports = mongoose.model("LiveStream", liveStreamSchema);