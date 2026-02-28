// src/config/firebaseAdmin.js
//
// Firebase Admin SDK — SADECE push notification göndermek için kullanılır.
// Tüm bildirim mantığı kendi backend'imizde.

const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return;

  try {
    // serviceAccountKey.json'ı proje kökünden yükle
    const keyPath = path.resolve(__dirname, "../../serviceAccountKey.json");

    if (!fs.existsSync(keyPath)) {
      console.warn(
        "⚠️ serviceAccountKey.json bulunamadı — push bildirimleri devre dışı"
      );
      return;
    }

    const serviceAccount = require(keyPath);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    initialized = true;
    console.log("🔔 Firebase Admin SDK başlatıldı (push notifications)");
  } catch (err) {
    console.error("❌ Firebase Admin SDK başlatma hatası:", err.message);
  }
}

/**
 * FCM ile push bildirim gönder
 *
 * @param {string} fcmToken - Hedef cihazın FCM token'ı
 * @param {string} title - Bildirim başlığı
 * @param {string} body - Bildirim içeriği
 * @param {Object} [data] - Ek veri (type, relatedId, vb.)
 * @returns {Promise<boolean>} Başarılı mı
 */
async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!initialized) {
    return false;
  }

  if (!fcmToken || !title) {
    return false;
  }

  try {
    const message = {
      token: fcmToken,
      notification: {
        title,
        body: body || "",
      },
      data: {
        // Tüm data değerleri string olmalı (FCM kuralı)
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
      android: {
        priority: "high",
        notification: {
          channelId: "eyra_notifications",
          sound: "default",
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
          },
        },
      },
    };

    await admin.messaging().send(message);
    return true;
  } catch (err) {
    // Token geçersiz → temizle
    if (
      err.code === "messaging/invalid-registration-token" ||
      err.code === "messaging/registration-token-not-registered"
    ) {
      console.warn(`⚠️ Geçersiz FCM token temizleniyor: ${fcmToken.substring(0, 20)}...`);
      const User = require("../models/User");
      await User.findOneAndUpdate(
        { fcmToken },
        { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
      );
    } else {
      console.error("❌ Push gönderme hatası:", err.message);
    }
    return false;
  }
}

module.exports = { initFirebaseAdmin, sendPushNotification };
