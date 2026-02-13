// src/models/Notification.js
const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    
    // Bildirim tipi
    type: {
      type: String,
      enum: [
        "follow",           // Biri sizi takip etti
        "gift_received",    // Hediye aldınız
        "call_incoming",    // Gelen arama
        "call_missed",      // Cevapsız arama
        "message",          // Yeni mesaj
        "live_started",     // Takip ettiğiniz kişi yayına başladı
        "mission_completed", // Görev tamamlandı
        "achievement",      // Başarım kazandınız
        "level_up",         // Seviye atladınız
        "vip_expiring",     // VIP süresi doluyor
        "system",           // Sistem bildirimi
        "report_update",    // Rapor durum güncellemesi
        "verification",     // Doğrulama durumu
        "daily_reminder",   // Günlük hatırlatma
        "spin_available",   // Çark kullanılabilir
        "coins_received",   // Coin hediyesi (admin)
      ],
      required: true,
    },
    
    // İçerik
    title: { type: String, required: true },
    titleEn: { type: String },
    body: { type: String, required: true },
    bodyEn: { type: String },
    imageUrl: { type: String },
    
    // İlişkiler
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    relatedId: { type: String }, // İlgili obje ID'si (stream, call vb.)
    relatedType: { type: String }, // 'stream', 'call', 'message', 'user'
    
    // Yönlendirme
    actionUrl: { type: String }, // Bildirime tıklayınca nereye gidecek
    actionData: { type: mongoose.Schema.Types.Mixed }, // Ekstra data (route params vb.)
    
    // Durum
    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    isPushed: { type: Boolean, default: false }, // FCM ile gönderildi mi
    pushedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// İndeksler
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });
notificationSchema.index({ type: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }); // 30 gün sonra sil

module.exports = mongoose.model("Notification", notificationSchema);
