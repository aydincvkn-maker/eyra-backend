// src/services/giftService.js
//
// ─────────────────────────────────────────────────────────────────────────────
// YENİ HEDİYE EKLEME REHBERİ — her hediye AYNI sistemde eklenmeli!
// ─────────────────────────────────────────────────────────────────────────────
// 1) Video dosyası   → public/videos/gifts/<isim>.mp4
// 2) Poster (jpg)    → public/gifts/<isim>.jpg
//                      (ffmpeg ile mp4'ün ~1. saniyesinden 256x256 frame al:
//                       ffmpeg -y -ss 00:00:01 -i in.mp4 -frames:v 1
//                         -vf "scale=256:256:force_original_aspect_ratio=increase,crop=256:256"
//                         -q:v 3 out.jpg)
// 3) DEFAULT_GIFTS dizisine kayıt ekle:
//      { name, description, imageUrl: "/gifts/<isim>.jpg",
//        animationUrl: "/videos/gifts/<isim>.mp4",
//        valueCoins, category: "basic"|"premium"|"vip"|"special", order }
// 4) Mobile tarafı  → eyra/lib/features/live/utils/gift_asset_paths.dart
//      a) MP4 ve JPG'i eyra/assets/{tier}/ altına kopyala (ASCII isim).
//      b) _imageAssetsByGiftKey map'ine 'gift_key': '<asset path>' ekle.
//      c) _themesByGiftKey map'ine GiftTheme ekle.
//      d) _resolveGiftKey içine spesifik isim/path eşleştirmesi ekle.
//
// syncDefaultGifts sunucu açılışında DB'yi bu listeye senkron eder; bu listede
// olmayan hediyeler isActive=false yapılır → mobile gift box'ta görünmez.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const Gift = require("../models/Gift");
const User = require("../models/User");
const LiveStream = require("../models/LiveStream");
const Message = require("../models/Message");
const Transaction = require("../models/Transaction");
const { trackMissionProgress } = require("../controllers/missionController");
const {
  checkGiftSentAchievements,
  checkGiftReceivedAchievements,
  checkCoinAchievements,
} = require("../controllers/achievementController");
const { logger } = require("../utils/logger");

// Rate limiting için memory cache
const giftRateLimits = new Map(); // `${userId}:${giftId}` -> { count, lastReset }
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 dakika
const RATE_LIMIT_MAX_GIFTS = 10; // 1 dakikada max 10 aynı hediye

// Mevcut medya dosyaları — sadece gerçekte var olan dosyalar
// NOTE: Use .mp4 only — iOS video_player has zero WebM support, and some
// Android decoders also fail on .webm. Both .mp4 and .webm files are present
// under public/videos/gifts/, so switching the URLs is sufficient.
const GIFT_MEDIA_BY_KEY = {
  ask: {
    imageUrl: "/gifts/ask.jpeg",
    animationUrl: "/videos/gifts/love.mp4",
  },
  opucuk: {
    imageUrl: "/gifts/opucuk.webp",
    animationUrl: "/videos/gifts/love_kiss.mp4",
  },
  hi: { imageUrl: "/gifts/hi.webp", animationUrl: "/videos/gifts/hi.mp4" },
  merhaba: { imageUrl: "/gifts/hi.webp", animationUrl: "/videos/gifts/hi.mp4" },
  kirmizi_araba: { imageUrl: "/gifts/kirmizi_araba.jpeg", animationUrl: null },
  ozel_jet: { imageUrl: "/gifts/ozel_jet.jpeg", animationUrl: null },
  rolex: {
    imageUrl: "/gifts/rolex.webp",
    animationUrl: "/videos/gifts/rolex.mp4",
  },
  yuzen_panda: {
    imageUrl: "/gifts/yuzen_panda.webp",
    animationUrl: "/videos/gifts/yuzen_panda.mp4",
  },
  kutu: { imageUrl: null, animationUrl: null },
  peri: { imageUrl: "/gifts/peri.jpeg", animationUrl: null },
  new_gift1: { imageUrl: "/gifts/ask.jpeg", animationUrl: null },
  new_gift2: { imageUrl: "/gifts/opucuk.webp", animationUrl: null },
  new_gift3: { imageUrl: "/gifts/new_gift3.jpg", animationUrl: null },
};

const normalizeGiftKey = (gift) => {
  const image = (gift?.imageUrl || "").toLowerCase();
  const name = (gift?.name || "").toLowerCase().trim();

  if (name === "aşk" || name.includes("love") || image.includes("love"))
    return "ask";
  if (name === "öpücük" || name.includes("kiss") || image.includes("kiss"))
    return "opucuk";
  if (name === "hi" || name === "merhaba") return "merhaba";
  if (
    name.includes("kırmızı") ||
    name.includes("araba") ||
    name.includes("kirmizi")
  )
    return "kirmizi_araba";
  if (name.includes("jet")) return "ozel_jet";
  if (
    name.includes("kutu") ||
    name.includes("box") ||
    name.includes("sandık") ||
    name.includes("sandik") ||
    image.includes("box")
  )
    return "kutu";
  if (name === "rolex" || image.includes("rolex")) return "rolex";
  if (
    name.includes("panda") ||
    name.includes("yuzen") ||
    name.includes("yüzen")
  )
    return "yuzen_panda";
  if (name === "peri" || image.includes("peri")) return "peri";
  if (image.includes("new_gift1") || name === "özel hediye 1")
    return "new_gift1";
  if (image.includes("new_gift2") || name === "özel hediye 2")
    return "new_gift2";
  if (image.includes("new_gift3") || name === "özel hediye 3")
    return "new_gift3";
  return null;
};

const resolveGiftMedia = (gift) => {
  const key = normalizeGiftKey(gift);
  if (!key) {
    return {
      imageUrl: gift?.imageUrl,
      animationUrl: gift?.animationUrl,
    };
  }
  return GIFT_MEDIA_BY_KEY[key];
};

// Sadece mevcut dosyalar kullanılıyor
const DEFAULT_GIFTS = [
  {
    name: "Aşk",
    description: "Sevgi dolu bir hediye",
    imageUrl: "/gifts/ask.jpeg",
    animationUrl: "/videos/gifts/love.mp4",
    valueCoins: 10,
    category: "basic",
    order: 1,
  },
  {
    name: "Öpücük",
    description: "Tatlı bir öpücük hediyesi",
    imageUrl: "/gifts/opucuk.webp",
    animationUrl: "/videos/gifts/love_kiss.mp4",
    valueCoins: 25,
    category: "basic",
    order: 2,
  },
  {
    name: "Merhaba",
    description: "Coşkulu bir selamlama",
    imageUrl: "/gifts/hi.webp",
    animationUrl: "/videos/gifts/hi.mp4",
    valueCoins: 75,
    category: "basic",
    order: 3,
  },
  {
    name: "Kırmızı Araba",
    description: "Süper bir araba hediyesi",
    imageUrl: "/gifts/kirmizi_araba.jpeg",
    animationUrl: null,
    valueCoins: 150,
    category: "basic",
    order: 4,
  },
  {
    name: "Özel Jet",
    description: "Lüks özel jet hediyesi",
    imageUrl: "/gifts/ozel_jet.jpeg",
    animationUrl: null,
    valueCoins: 300,
    category: "vip",
    order: 2,
  },
  {
    name: "Rolex",
    description: "Lüks saat hediyesi",
    imageUrl: "/gifts/rolex.webp",
    animationUrl: "/videos/gifts/rolex.mp4",
    valueCoins: 500,
    category: "vip",
    order: 1,
  },
  {
    name: "Yüzen Panda",
    description: "Sevimli yüzen panda",
    imageUrl: "/gifts/yuzen_panda.webp",
    animationUrl: "/videos/gifts/yuzen_panda.mp4",
    valueCoins: 2000,
    category: "premium",
    order: 1,
  },
  {
    name: "Peri",
    description: "En değerli peri hediyesi",
    imageUrl: "/gifts/peri.jpeg",
    animationUrl: null,
    valueCoins: 999999,
    category: "special",
    order: 1,
  },

  // ─────────── basic (temel) ───────────
  {
    name: "Şaplak",
    description: "Şakacı bir şaplak",
    imageUrl: "/gifts/saplak.jpg",
    animationUrl: "/videos/gifts/saplak.mp4",
    valueCoins: 50,
    category: "basic",
    order: 5,
  },
  {
    name: "Bulutlar",
    description: "Pamuk gibi bulutlar",
    imageUrl: "/gifts/bulutlar.jpg",
    animationUrl: "/videos/gifts/bulutlar.mp4",
    valueCoins: 20,
    category: "basic",
    order: 6,
  },
  {
    name: "Speed",
    description: "Hız esintisi",
    imageUrl: "/gifts/speed.jpg",
    animationUrl: "/videos/gifts/speed.mp4",
    valueCoins: 40,
    category: "basic",
    order: 7,
  },

  // ─────────── premium ───────────
  {
    name: "Dans",
    description: "Coşkulu dans şovu",
    imageUrl: "/gifts/dans.jpg",
    animationUrl: "/videos/gifts/dans.mp4",
    valueCoins: 400,
    category: "premium",
    order: 2,
  },
  {
    name: "Hız Motoru",
    description: "Yüksek hız motoru",
    imageUrl: "/gifts/hiz_motoru.jpg",
    animationUrl: "/videos/gifts/hiz_motoru.mp4",
    valueCoins: 600,
    category: "premium",
    order: 3,
  },
  {
    name: "Doğum Günü",
    description: "Mutlu yıllar pastası",
    imageUrl: "/gifts/happy_birthday.jpg",
    animationUrl: "/videos/gifts/happy_birthday.mp4",
    valueCoins: 300,
    category: "premium",
    order: 4,
  },
  {
    name: "At",
    description: "Asil bir at hediyesi",
    imageUrl: "/gifts/horse.jpg",
    animationUrl: "/videos/gifts/horse.mp4",
    valueCoins: 800,
    category: "premium",
    order: 5,
  },
  {
    name: "Kartal",
    description: "Görkemli bir kartal",
    imageUrl: "/gifts/kartal.jpg",
    animationUrl: "/videos/gifts/kartal.mp4",
    valueCoins: 1000,
    category: "premium",
    order: 6,
  },
  {
    name: "Aslan",
    description: "Cesur bir aslan",
    imageUrl: "/gifts/lion.jpg",
    animationUrl: "/videos/gifts/lion.mp4",
    valueCoins: 1200,
    category: "premium",
    order: 7,
  },
  {
    name: "Aşk Arabası",
    description: "Aşk dolu bir araba",
    imageUrl: "/gifts/love_car.jpg",
    animationUrl: "/videos/gifts/love_car.mp4",
    valueCoins: 900,
    category: "premium",
    order: 8,
  },
  {
    name: "Aşk Kalbi",
    description: "Çarpan bir kalp",
    imageUrl: "/gifts/love_heart.jpg",
    animationUrl: "/videos/gifts/love_heart.mp4",
    valueCoins: 350,
    category: "premium",
    order: 9,
  },
  {
    name: "Motor",
    description: "Hızlı motorsiklet",
    imageUrl: "/gifts/motor1.jpg",
    animationUrl: "/videos/gifts/motor1.mp4",
    valueCoins: 700,
    category: "premium",
    order: 10,
  },
  {
    name: "Seni Seviyorum",
    description: "Sevgi dolu mesaj",
    imageUrl: "/gifts/i_love_you.jpg",
    animationUrl: "/videos/gifts/i_love_you.mp4",
    valueCoins: 500,
    category: "premium",
    order: 11,
  },
  {
    name: "Seni Seviyorum +",
    description: "Daha büyük bir aşk mesajı",
    imageUrl: "/gifts/i_love_you_1.jpg",
    animationUrl: "/videos/gifts/i_love_you_1.mp4",
    valueCoins: 550,
    category: "premium",
    order: 12,
  },

  // ─────────── vip ───────────
  {
    name: "Venüs Araba",
    description: "Altın değerinde lüks araba",
    imageUrl: "/gifts/venus_car.jpg",
    animationUrl: "/videos/gifts/venus_car.mp4",
    valueCoins: 1500,
    category: "vip",
    order: 3,
  },
  {
    name: "Yat",
    description: "Görkemli yat hediyesi",
    imageUrl: "/gifts/yat.jpg",
    animationUrl: "/videos/gifts/yat.mp4",
    valueCoins: 2500,
    category: "vip",
    order: 4,
  },
  {
    name: "Buz Araba",
    description: "Buzdan zarif bir araba",
    imageUrl: "/gifts/ice_car.jpg",
    animationUrl: "/videos/gifts/ice_car.mp4",
    valueCoins: 1800,
    category: "vip",
    order: 5,
  },

  // ─────────── special (ozel) ───────────
  {
    name: "Drakula",
    description: "Gizemli drakula",
    imageUrl: "/gifts/drakula.jpg",
    animationUrl: "/videos/gifts/drakula.mp4",
    valueCoins: 50000,
    category: "special",
    order: 2,
  },
  {
    name: "Gözcü",
    description: "Sezgisel gözcü",
    imageUrl: "/gifts/gozcu.jpg",
    animationUrl: "/videos/gifts/gozcu.mp4",
    valueCoins: 30000,
    category: "special",
    order: 3,
  },
  {
    name: "Kılıç Ustası",
    description: "Efsane kılıç ustası",
    imageUrl: "/gifts/kilic_ustasi.jpg",
    animationUrl: "/videos/gifts/kilic_ustasi.mp4",
    valueCoins: 40000,
    category: "special",
    order: 4,
  },
  {
    name: "Şeytan",
    description: "Yakıcı şeytan",
    imageUrl: "/gifts/seytan.jpg",
    animationUrl: "/videos/gifts/seytan.mp4",
    valueCoins: 75000,
    category: "special",
    order: 5,
  },
];

// Geçerli hediye adları seti — eski/eksik hediyeler devre dışı bırakılır
const DEFAULT_GIFT_NAMES = new Set(DEFAULT_GIFTS.map((g) => g.name));

const syncDefaultGifts = async () => {
  const existingGifts = await Gift.find(
    {},
    "name description imageUrl animationUrl valueCoins category order isActive",
  ).lean();
  const existingByName = new Map(
    existingGifts.filter((g) => g.name).map((g) => [g.name, g]),
  );

  let insertedCount = 0;
  let updatedCount = 0;
  let deactivatedCount = 0;

  // Eski/geçersiz hediyeleri devre dışı bırak
  for (const existing of existingGifts) {
    if (existing.isActive && !DEFAULT_GIFT_NAMES.has(existing.name)) {
      await Gift.updateOne(
        { _id: existing._id },
        { $set: { isActive: false } },
      );
      deactivatedCount += 1;
    }
  }

  // Yeni/güncel hediyeleri ekle/güncelle
  for (const defaultGift of DEFAULT_GIFTS) {
    const existingGift = existingByName.get(defaultGift.name);

    if (!existingGift) {
      await Gift.create(defaultGift);
      insertedCount += 1;
      continue;
    }

    const needsUpdate =
      existingGift.description !== defaultGift.description ||
      existingGift.imageUrl !== defaultGift.imageUrl ||
      (existingGift.animationUrl || null) !==
        (defaultGift.animationUrl || null) ||
      existingGift.valueCoins !== defaultGift.valueCoins ||
      existingGift.category !== defaultGift.category ||
      existingGift.order !== defaultGift.order ||
      existingGift.isActive !== true;

    if (needsUpdate) {
      await Gift.updateOne(
        { _id: existingGift._id },
        {
          $set: {
            description: defaultGift.description,
            imageUrl: defaultGift.imageUrl,
            animationUrl: defaultGift.animationUrl || null,
            valueCoins: defaultGift.valueCoins,
            category: defaultGift.category,
            order: defaultGift.order,
            isActive: true,
          },
        },
      );
      updatedCount += 1;
    }
  }

  logger.info("Default gifts synced", {
    insertedCount,
    updatedCount,
    deactivatedCount,
  });
  return insertedCount;
};

// Periyodik temizlik — expired rate limit kayıtlarını sil (her 2 dakika)
setInterval(
  () => {
    const now = Date.now();
    for (const [key, record] of giftRateLimits.entries()) {
      if (now - record.lastReset > RATE_LIMIT_WINDOW_MS * 2) {
        giftRateLimits.delete(key);
      }
    }
  },
  2 * 60 * 1000,
).unref();

/**
 * Hediye gönderimini rate limit ile kontrol et
 */
const checkRateLimit = (userId, giftId) => {
  const key = `${userId}:${giftId}`;
  const now = Date.now();

  let record = giftRateLimits.get(key);

  if (!record || now - record.lastReset > RATE_LIMIT_WINDOW_MS) {
    record = { count: 0, lastReset: now };
  }

  if (record.count >= RATE_LIMIT_MAX_GIFTS) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  giftRateLimits.set(key, record);

  return { allowed: true, remaining: RATE_LIMIT_MAX_GIFTS - record.count };
};

/**
 * Tüm aktif hediyeleri getir
 */
exports.getAllGifts = async (category = null) => {
  await syncDefaultGifts();

  const query = { isActive: true };
  if (category) {
    query.category = category;
  }

  return Gift.find(query).sort({ category: 1, order: 1, valueCoins: 1 }).lean();
};

/**
 * Hediye gönder - coin düş, yayıncıya ekle
 */
exports.sendGift = async ({
  senderId,
  recipientId,
  giftId,
  liveId,
  roomId,
}) => {
  // 1. Hediyeyi bul
  const gift = await Gift.findById(giftId);
  if (!gift || !gift.isActive) {
    throw new Error("Hediye bulunamadı veya aktif değil");
  }

  // 2. Rate limit kontrolü
  const rateCheck = checkRateLimit(senderId, giftId);
  if (!rateCheck.allowed) {
    throw new Error("Çok hızlı hediye gönderiyorsunuz. Lütfen bekleyin.");
  }

  // 3. LiveStream bul (varsa) — yoksa direkt (kullanıcı→kullanıcı) hediye modu
  let live = null;
  if (liveId) {
    live = await LiveStream.findById(liveId);
  } else if (roomId) {
    live = await LiveStream.findOne({ roomId, isLive: true });
  }

  // Direkt hediye gönderiminde live olmayabilir; bu durumda recipientId zorunlu
  if (!live && !recipientId) {
    throw new Error("Alıcı belirtilmedi (yayın yok)");
  }

  const actualRecipientId = recipientId || live.host;

  // 4. Atomik coin transferi — sender'dan düş, recipient'e ekle
  //    $inc + filter ile TOCTOU race condition önlenir
  const recipientShare = Math.floor(gift.valueCoins * 0.45);

  // Sender: atomik coin düşürme (coins >= valueCoins kontrolü filter'da)
  const updatedSender = await User.findOneAndUpdate(
    { _id: senderId, coins: { $gte: gift.valueCoins } },
    { $inc: { coins: -gift.valueCoins } },
    { new: true, select: "coins name username profileImage" },
  );
  if (!updatedSender) {
    // Ya kullanıcı yok ya da yetersiz coin
    const exists = await User.exists({ _id: senderId });
    throw new Error(exists ? "Yetersiz coin" : "Gönderici bulunamadı");
  }

  // Recipient: atomik coin ekleme
  const updatedRecipient = await User.findByIdAndUpdate(
    actualRecipientId,
    { $inc: { coins: recipientShare, totalEarnings: recipientShare } },
    { new: true, select: "coins" },
  );
  if (!updatedRecipient) {
    // Recipient bulunamadı — sender'a coin'i geri ver
    await User.findByIdAndUpdate(senderId, {
      $inc: { coins: gift.valueCoins },
    });
    throw new Error("Alıcı bulunamadı");
  }

  // LiveStream toplam hediye değerini güncelle (atomik) — sadece yayın varsa
  if (live) {
    await LiveStream.findByIdAndUpdate(live._id, {
      $inc: { totalGiftsValue: gift.valueCoins, totalGiftsCount: 1 },
    });
  }

  // Gift istatistiklerini güncelle (atomik)
  await Gift.findByIdAndUpdate(giftId, {
    $inc: { totalSent: 1, totalCoinsSpent: gift.valueCoins },
  });

  const media = resolveGiftMedia(gift);
  const resolvedImageUrl = media.imageUrl || gift.imageUrl;
  const resolvedAnimationUrl = media.animationUrl || gift.animationUrl;

  // 5. Mesaj olarak kaydet (chat'te görünsün) — yayın yoksa DM odası uydur
  const directRoomId = (() => {
    const ids = [String(senderId), String(actualRecipientId)].sort();
    return `dm:${ids[0]}:${ids[1]}`;
  })();
  const message = await Message.create({
    roomId: live ? live.roomId : directRoomId,
    from: senderId,
    to: actualRecipientId,
    type: "gift",
    content: JSON.stringify({
      giftId: gift._id,
      giftName: gift.name,
      giftImage: resolvedImageUrl,
      giftAnimation: resolvedAnimationUrl,
      valueCoins: gift.valueCoins,
      senderName: updatedSender.name || updatedSender.username,
      senderImage: updatedSender.profileImage,
    }),
  });

  // 9. Socket event emit et
  if (global.io) {
    const giftPayload = {
      messageId: message._id,
      giftId: gift._id,
      giftName: gift.name,
      giftImage: resolvedImageUrl,
      giftAnimation: resolvedAnimationUrl,
      valueCoins: gift.valueCoins,
      senderId: senderId,
      senderName: updatedSender.name || updatedSender.username,
      senderImage: updatedSender.profileImage,
      recipientId: actualRecipientId,
      roomId: live ? live.roomId : null,
      timestamp: new Date().toISOString(),
    };
    if (live) {
      global.io.to(live.roomId).emit("gift_received", giftPayload);
    } else {
      // Direkt hediye: alıcı + gönderene bildir
      try {
        const { emitToUserSockets } = require("../socket/helpers");
        emitToUserSockets(
          String(actualRecipientId),
          "gift_received",
          giftPayload,
        );
        emitToUserSockets(String(senderId), "gift_received", giftPayload);

        // Mesajlaşma listesinde küçük bir bildirim olarak görünsün diye
        // chat:new_message olarak da yayınla. Frontend bunu özel "gift" mesajı
        // olarak render edecek (küçük görsel + "X sent Y").
        const chatPayload = {
          messageId: message._id.toString(),
          from: String(senderId),
          to: String(actualRecipientId),
          text: `🎁 ${updatedSender.name || updatedSender.username || "Birisi"} sent ${gift.name}`,
          timestamp: message.createdAt,
          mediaUrl: resolvedImageUrl,
          mediaType: "gift",
          isGift: true,
          giftName: gift.name,
          giftImage: resolvedImageUrl,
          giftValue: gift.valueCoins,
          isMe: false,
        };
        emitToUserSockets(
          String(actualRecipientId),
          "chat:new_message",
          chatPayload,
        );
        emitToUserSockets(String(senderId), "chat:new_message", {
          ...chatPayload,
          isMe: true,
        });
      } catch (e) {
        logger.warn("Direct gift emit failed:", e.message);
      }
    }
  }

  // 10. Post-gift hooks: Transaction kaydet, mission ilerlet, achievement kontrol
  //     Fire-and-forget — hediye gönderimini yavaşlatmaz
  exports
    .postGiftHooks({
      senderId,
      recipientId: actualRecipientId,
      giftId: gift._id,
      giftValue: gift.valueCoins,
      senderCoins: updatedSender.coins,
      recipientCoins: updatedRecipient.coins,
    })
    .catch((err) => logger.error("postGiftHooks fire-and-forget error:", err));

  return {
    success: true,
    message,
    gift: {
      id: gift._id,
      name: gift.name,
      imageUrl: resolvedImageUrl,
      animationUrl: resolvedAnimationUrl,
      valueCoins: gift.valueCoins,
    },
    senderCoins: updatedSender.coins,
    recipientEarnings: recipientShare,
  };
};

// =============================================
// TRANSACTION & MISSION TRACKING (post-gift hooks)
// =============================================

/**
 * Hediye gönderimi sonrası: Transaction kaydet, mission ilerlet, achievement kontrol
 * sendGift fonksiyonundan sonra çağrılır
 */
exports.postGiftHooks = async ({
  senderId,
  recipientId,
  giftId,
  giftValue,
  senderCoins,
  recipientCoins,
}) => {
  try {
    // Transaction kaydet - sender
    await Transaction.create({
      user: senderId,
      type: "gift_sent",
      amount: -giftValue,
      balanceAfter: senderCoins,
      relatedUser: recipientId,
      relatedGift: giftId,
      description: `Hediye gönderildi`,
    });

    // Transaction kaydet - recipient
    const recipientShare = Math.floor(giftValue * 0.45);
    await Transaction.create({
      user: recipientId,
      type: "gift_received",
      amount: recipientShare,
      balanceAfter: recipientCoins,
      relatedUser: senderId,
      relatedGift: giftId,
      description: `Hediye alındı`,
    });

    // Mission progress
    await trackMissionProgress(senderId, "send_gift", 1);

    // XP ekle - sender
    try {
      const senderUser = await User.findById(senderId);
      if (senderUser) {
        await senderUser.addXP(5); // Hediye gönderme XP
      }
    } catch (e) {}

    // Achievement kontrolü
    const senderGiftCount = await Message.countDocuments({
      from: senderId,
      type: "gift",
    });
    await checkGiftSentAchievements(senderId, senderGiftCount);
    await checkGiftReceivedAchievements(recipientId);
    await checkCoinAchievements(senderId, senderCoins);
  } catch (err) {
    logger.error("postGiftHooks error:", err);
  }
};

/**
 * Kullanıcının gönderdiği hediye geçmişi
 */
exports.getGiftHistory = async (userId, limit = 50) => {
  return await Message.find({
    from: userId,
    type: "gift",
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("to", "username name profileImage");
};

/**
 * Yayıncının aldığı hediyeler
 */
exports.getReceivedGifts = async (userId, limit = 50) => {
  return await Message.find({
    to: userId,
    type: "gift",
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("from", "username name profileImage");
};

/**
 * Yayın için hediye istatistikleri
 */
exports.getLiveGiftStats = async (liveId) => {
  const live = await LiveStream.findById(liveId);
  if (!live) return null;

  const giftMessages = await Message.find({
    roomId: live.roomId,
    type: "gift",
  });

  let totalValue = 0;
  const giftCounts = {};
  const topSenders = {};

  for (const msg of giftMessages) {
    try {
      const content = JSON.parse(msg.content);
      totalValue += content.valueCoins || 0;

      // Gift sayısı
      const giftName = content.giftName || "Unknown";
      giftCounts[giftName] = (giftCounts[giftName] || 0) + 1;

      // Top sender
      const senderId = String(msg.from);
      topSenders[senderId] =
        (topSenders[senderId] || 0) + (content.valueCoins || 0);
    } catch (e) {
      // JSON parse hatası, devam et
    }
  }

  return {
    totalValue,
    totalGifts: giftMessages.length,
    giftCounts,
    topSenders: Object.entries(topSenders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, total]) => ({ userId, total })),
  };
};

/**
 * Admin: Yeni hediye oluştur
 */
exports.createGift = async (giftData) => {
  return await Gift.create(giftData);
};

/**
 * Admin: Hediye güncelle
 */
exports.updateGift = async (giftId, updates) => {
  return await Gift.findByIdAndUpdate(giftId, updates, { new: true });
};

/**
 * Admin: Hediye sil (soft delete)
 */
exports.deleteGift = async (giftId) => {
  return await Gift.findByIdAndUpdate(
    giftId,
    { isActive: false },
    { new: true },
  );
};

/**
 * Default hediyeleri oluştur (ilk setup için)
 */
exports.seedDefaultGifts = async () => {
  const existingCount = await Gift.countDocuments({ isActive: true });
  if (existingCount > 0) {
    const synced = await syncDefaultGifts();
    logger.info(
      synced > 0 ? "Missing default gifts added" : "Gifts already seeded",
    );
    return;
  }

  await Gift.insertMany(DEFAULT_GIFTS);
  logger.info("✅ Default gifts seeded:", DEFAULT_GIFTS.length);
};
