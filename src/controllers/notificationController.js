// src/controllers/notificationController.js
const Notification = require("../models/Notification");
const User = require("../models/User");
const { sendPushNotification } = require("../config/firebaseAdmin");

// =============================================
// BİLDİRİM TİPİ → AYAR EŞLEME
// =============================================
// Her bildirim tipinin hangi kullanıcı ayarına bağlı olduğu
const NOTIFICATION_TYPE_TO_SETTING = {
  message: "messageNotifications",
  chat_message: "messageNotifications",
  call_missed: "callNotifications",
  call_incoming: "callNotifications",
  profile_visit: "visitorNotifications",
  follow: "followNotifications",
  gift_received: "giftNotifications",
  // Bu tipler her zaman gönderilir (ayarla filtrelenmez)
  system: null,
  achievement: null,
  mission_completed: null,
  level_up: null,
  coins_received: null,
  vip_expiring: null,
  report_resolved: null,
  salary_payment: null,
};

// =============================================
// NOTIFICATION SERVICE HELPER
// =============================================

/**
 * Bildirim oluştur + push gönder
 *
 * Akış:
 *  1. DB'ye in-app bildirim kaydı oluştur
 *  2. Kullanıcının ilgili bildirim ayarını kontrol et
 *  3. FCM token varsa ve ayar açıksa → push gönder
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
    // 1) DB'ye in-app bildirim kaydet
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

    // 2) Push bildirim gönder (arka planda, hata fırlatmaz)
    try {
      const recipient = await User.findById(recipientId)
        .select("fcmToken settings")
        .lean();

      if (recipient && recipient.fcmToken) {
        // Master push switch
        const pushEnabled = recipient.settings?.pushNotifications !== false;
        if (!pushEnabled) return notification;

        // Tip bazlı ayar kontrolü
        const settingKey = NOTIFICATION_TYPE_TO_SETTING[type];
        if (settingKey && recipient.settings?.[settingKey] === false) {
          // Kullanıcı bu tip bildirimi kapatmış
          return notification;
        }

        const pushed = await sendPushNotification(
          recipient.fcmToken,
          title,
          body,
          {
            type: type || "system",
            notificationId: notification._id.toString(),
            relatedId: relatedId || "",
            relatedType: relatedType || "",
          }
        );

        if (pushed) {
          await Notification.findByIdAndUpdate(notification._id, {
            $set: { isPushed: true, pushedAt: new Date() },
          });
        }
      }
    } catch (pushErr) {
      // Push hatası in-app bildirimi engellemez
      console.error("Push gönderme hatası:", pushErr.message);
    }

    return notification;
  } catch (err) {
    console.error("createNotification error:", err);
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
    const { title, body, type, recipientIds, targetUserId } = req.body;

    if (!title || !body) {
      return res
        .status(400)
        .json({ success: false, message: "Başlık ve mesaj gerekli" });
    }

    let recipients;
    if (targetUserId) {
      // Admin panelden tek kullanıcıya gönderim
      recipients = await User.find({ _id: targetUserId }).select("_id");
      if (!recipients.length) {
        return res
          .status(404)
          .json({ success: false, message: "Kullanıcı bulunamadı" });
      }
    } else if (recipientIds && recipientIds.length > 0) {
      // Birden fazla kullanıcıya gönderim (API desteği)
      recipients = await User.find({
        _id: { $in: recipientIds },
      }).select("_id");
    } else {
      // Tüm kullanıcılara toplu gönderim
      recipients = await User.find({}).select("_id");
    }

    console.log(`📢 Admin bildirim gönderiliyor: ${recipients.length} alıcı, başlık: "${title}"`);

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
        console.error(`Bildirim oluşturulamadı (user: ${recipient._id}):`, e.message);
        failed++;
      }
    }

    console.log(`✅ Admin bildirim sonuç: ${sent} başarılı, ${failed} başarısız`);

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
