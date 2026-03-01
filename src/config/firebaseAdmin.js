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
    let serviceAccount;

    // 1. Try FIREBASE_SERVICE_ACCOUNT env variable first (recommended for production)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("🔔 Firebase credentials loaded from FIREBASE_SERVICE_ACCOUNT env var");
      } catch (parseErr) {
        console.error("❌ FIREBASE_SERVICE_ACCOUNT env var is not valid JSON:", parseErr.message);
        return;
      }
    }

    // 2. Fallback to serviceAccountKey.json file (development only)
    if (!serviceAccount) {
      const keyPath = path.resolve(__dirname, "../../serviceAccountKey.json");
      if (fs.existsSync(keyPath)) {
        serviceAccount = require(keyPath);
        console.log("🔔 Firebase credentials loaded from serviceAccountKey.json (dev fallback)");
      }
    }

    if (!serviceAccount) {
      console.warn(
        "⚠️ Firebase credentials not found — push notifications disabled.\n" +
        "   Set FIREBASE_SERVICE_ACCOUNT env var or provide serviceAccountKey.json"
      );
      return;
    }

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
