// src/controllers/notificationController.js
const Notification = require("../models/Notification");
const User = require("../models/User");

// =============================================
// NOTIFICATION SERVICE HELPER
// =============================================

/**
 * Bildirim oluştur ve (opsiyonel) push gönder
 */
exports.createNotification = async ({
  recipientId,
  type,
  title,
  titleEn,
  body,
  bodyEn,
  senderId,
  relatedId,
  relatedType,
  actionUrl,
  actionData,
  imageUrl,
}) => {
  try {
    const notification = await Notification.create({
      recipient: recipientId,
      type,
      title,
      titleEn: titleEn || title,
      body,
      bodyEn: bodyEn || body,
      sender: senderId || null,
      relatedId: relatedId || null,
      relatedType: relatedType || null,
      actionUrl: actionUrl || null,
      actionData: actionData || null,
      imageUrl: imageUrl || null,
    });

    // FCM Push Notification gönderme
    try {
      const recipient = await User.findById(recipientId).select("fcmToken settings");
      if (
        recipient?.fcmToken &&
        recipient.settings?.pushNotifications !== false
      ) {
        await sendPushNotification(recipient.fcmToken, {
          title: title,
          body: body,
          data: {
            type,
            notificationId: String(notification._id),
            relatedId: relatedId || "",
            relatedType: relatedType || "",
          },
        });
        
        // isPushed güncelle
        await Notification.findByIdAndUpdate(notification._id, {
          $set: { isPushed: true, pushedAt: new Date() },
        });
      }
    } catch (pushErr) {
      console.warn("Push notification gönderilemedi:", pushErr.message);
    }

    return notification;
  } catch (err) {
    console.error("createNotification error:", err);
    return null;
  }
};

/**
 * FCM Push Notification gönder
 * NOT: Firebase Admin SDK konfigürasyonu gerekir
 */
const sendPushNotification = async (fcmToken, { title, body, data }) => {
  try {
    // Firebase Admin SDK kullan
    const admin = require("firebase-admin");
    
    // Firebase Admin başlatılmamışsa başlat
    if (!admin.apps.length) {
      const serviceAccount = require("../../serviceAccountKey.json");
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    const message = {
      notification: { title, body },
      data: data || {},
      token: fcmToken,
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "eyra_notifications",
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

    const result = await admin.messaging().send(message);
    console.log("📱 Push notification gönderildi:", result);
    return result;
  } catch (err) {
    // Token geçersizse temizle
    if (
      err.code === "messaging/invalid-registration-token" ||
      err.code === "messaging/registration-token-not-registered"
    ) {
      console.log("🗑️ Geçersiz FCM token temizleniyor");
      await User.findOneAndUpdate(
        { fcmToken },
        { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
      );
    }
    throw err;
  }
};

// =============================================
// API ENDPOINTS
// =============================================

// GET /api/notifications - Bildirimlerimi getir
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20"), 1), 100);
    const type = req.query.type;

    const query = { recipient: userId };
    if (type) query.type = type;

    const total = await Notification.countDocuments(query);
    const notifications = await Notification.find(query)
      .populate("sender", "_id username name profileImage")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      notifications,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getNotifications error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/notifications/unread-count - Okunmamış bildirim sayısı
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await Notification.countDocuments({
      recipient: userId,
      isRead: false,
    });
    res.json({ success: true, count });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/notifications/:notificationId/read - Bildirimi okundu olarak işaretle
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { notificationId } = req.params;

    await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: userId },
      { $set: { isRead: true, readAt: new Date() } }
    );

    res.json({ success: true, message: "Okundu olarak işaretlendi" });
  } catch (err) {
    console.error("markAsRead error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// PUT /api/notifications/read-all - Tümünü okundu olarak işaretle
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    await Notification.updateMany(
      { recipient: userId, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );

    res.json({ success: true, message: "Tüm bildirimler okundu" });
  } catch (err) {
    console.error("markAllAsRead error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/notifications/:notificationId - Bildirimi sil
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.user.id;
    const { notificationId } = req.params;

    await Notification.findOneAndDelete({
      _id: notificationId,
      recipient: userId,
    });

    res.json({ success: true, message: "Bildirim silindi" });
  } catch (err) {
    console.error("deleteNotification error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/notifications/fcm-token - FCM token kaydet
exports.updateFcmToken = async (req, res) => {
  try {
    const userId = req.user.id;
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res
        .status(400)
        .json({ success: false, message: "FCM token gerekli" });
    }

    await User.findByIdAndUpdate(userId, {
      $set: { fcmToken, fcmTokenUpdatedAt: new Date() },
    });

    res.json({ success: true, message: "FCM token güncellendi" });
  } catch (err) {
    console.error("updateFcmToken error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/notifications/fcm-token - FCM token sil (logout)
exports.removeFcmToken = async (req, res) => {
  try {
    const userId = req.user.id;
    await User.findByIdAndUpdate(userId, {
      $set: { fcmToken: null, fcmTokenUpdatedAt: null },
    });

    res.json({ success: true, message: "FCM token kaldırıldı" });
  } catch (err) {
    console.error("removeFcmToken error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/notifications/admin/send - Admin toplu bildirim gönder
exports.adminSendNotification = async (req, res) => {
  try {
    const { title, body, type, recipientIds } = req.body;

    if (!title || !body) {
      return res
        .status(400)
        .json({ success: false, message: "Başlık ve mesaj gerekli" });
    }

    let recipients;
    if (recipientIds && recipientIds.length > 0) {
      recipients = await User.find({
        _id: { $in: recipientIds },
      }).select("_id fcmToken settings");
    } else {
      // Tüm kullanıcılara gönder (in-app bildirim için FCM token şartı yok)
      recipients = await User.find({
        "settings.pushNotifications": { $ne: false },
      }).select("_id fcmToken settings");
    }

    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
      try {
        await exports.createNotification({
          recipientId: recipient._id,
          type: type || "system",
          title,
          body,
          senderId: req.user.id,
        });
        sent++;
      } catch (e) {
        failed++;
      }
    }

    res.json({
      success: true,
      message: `${sent} bildirim gönderildi, ${failed} başarısız`,
      sent,
      failed,
    });
  } catch (err) {
    console.error("adminSendNotification error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
