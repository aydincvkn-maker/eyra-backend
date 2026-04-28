// src/services/giftService.js
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
const GIFT_MEDIA_BY_KEY = {
  ask:        { imageUrl: "/gifts/new_gift1.jpg", animationUrl: "/videos/gifts/love.mp4" },
  opucuk:     { imageUrl: "/gifts/new_gift2.jpg", animationUrl: "/videos/gifts/love_kiss.mp4" },
  hi:         { imageUrl: "/gifts/box.png",        animationUrl: "/videos/gifts/hi.mp4" },
  rolex:      { imageUrl: "/gifts/new_gift3.jpg", animationUrl: "/videos/gifts/rolex.mp4" },
  yuzen_panda:{ imageUrl: "/gifts/box.png",        animationUrl: "/videos/gifts/yuzen_panda.mp4" },
  peri:       { imageUrl: "/gifts/peri.jpg",       animationUrl: null },
  new_gift1:  { imageUrl: "/gifts/new_gift1.jpg",  animationUrl: null },
  new_gift2:  { imageUrl: "/gifts/new_gift2.jpg",  animationUrl: null },
  new_gift3:  { imageUrl: "/gifts/new_gift3.jpg",  animationUrl: null },
};

const normalizeGiftKey = (gift) => {
  const image = (gift?.imageUrl || "").toLowerCase();
  const name  = (gift?.name   || "").toLowerCase().trim();

  if (name === "aşk"   || name.includes("love") || image.includes("love"))        return "ask";
  if (name === "öpücük"|| name.includes("kiss") || image.includes("kiss"))        return "opucuk";
  if (name === "hi"    || name === "merhaba")                                       return "hi";
  if (name === "rolex" || image.includes("rolex"))                                  return "rolex";
  if (name.includes("panda") || name.includes("yuzen") || name.includes("yüzen")) return "yuzen_panda";
  if (name === "peri"  || image.includes("peri"))                                   return "peri";
  if (image.includes("new_gift1") || name === "özel hediye 1")                     return "new_gift1";
  if (image.includes("new_gift2") || name === "özel hediye 2")                     return "new_gift2";
  if (image.includes("new_gift3") || name === "özel hediye 3")                     return "new_gift3";
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
    imageUrl: "/gifts/new_gift1.jpg",
    animationUrl: "/videos/gifts/love.mp4",
    valueCoins: 10,
    category: "basic",
    order: 1,
  },
  {
    name: "Öpücük",
    description: "Tatlı bir öpücük hediyesi",
    imageUrl: "/gifts/new_gift2.jpg",
    animationUrl: "/videos/gifts/love_kiss.mp4",
    valueCoins: 25,
    category: "basic",
    order: 2,
  },
  {
    name: "Hi",
    description: "Coşkulu bir merhaba",
    imageUrl: "/gifts/box.png",
    animationUrl: "/videos/gifts/hi.mp4",
    valueCoins: 75,
    category: "basic",
    order: 3,
  },
  {
    name: "Özel Hediye 1",
    description: "Özel hediye",
    imageUrl: "/gifts/new_gift1.jpg",
    animationUrl: null,
    valueCoins: 100,
    category: "premium",
    order: 1,
  },
  {
    name: "Özel Hediye 2",
    description: "Özel hediye",
    imageUrl: "/gifts/new_gift2.jpg",
    animationUrl: null,
    valueCoins: 300,
    category: "premium",
    order: 2,
  },
  {
    name: "Rolex",
    description: "Lüks saat hediyesi",
    imageUrl: "/gifts/new_gift3.jpg",
    animationUrl: "/videos/gifts/rolex.mp4",
    valueCoins: 500,
    category: "premium",
    order: 3,
  },
  {
    name: "Özel Hediye 3",
    description: "Özel hediye",
    imageUrl: "/gifts/new_gift3.jpg",
    animationUrl: null,
    valueCoins: 800,
    category: "premium",
    order: 4,
  },
  {
    name: "Yüzen Panda",
    description: "Sevimli yüzen panda",
    imageUrl: "/gifts/box.png",
    animationUrl: "/videos/gifts/yuzen_panda.mp4",
    valueCoins: 2000,
    category: "vip",
    order: 1,
  },
  {
    name: "Peri",
    description: "En değerli peri hediyesi",
    imageUrl: "/gifts/peri.jpg",
    animationUrl: null,
    valueCoins: 999999,
    category: "special",
    order: 1,
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
      await Gift.updateOne({ _id: existing._id }, { $set: { isActive: false } });
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
      (existingGift.animationUrl || null) !== (defaultGift.animationUrl || null) ||
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

  logger.info("Default gifts synced", { insertedCount, updatedCount, deactivatedCount });
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
  const periGiftPayload = {
    name: "Peri",
    description: "En değerli peri hediyesi",
    imageUrl: "/gifts/peri.jpg",
    valueCoins: 999999,
    category: "basic",
    order: 1,
    isActive: true,
  };

  await Gift.findOneAndUpdate(
    { name: periGiftPayload.name },
    { $set: periGiftPayload },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await syncDefaultGifts();

  const query = { isActive: true };
  if (category) {
    query.category = category;
  }

  return Gift.find(query).sort({ valueCoins: -1, order: 1 }).lean();
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

  // 3. LiveStream bul (varsa)
  let live = null;
  if (liveId) {
    live = await LiveStream.findById(liveId);
  } else if (roomId) {
    live = await LiveStream.findOne({ roomId, isLive: true });
  }

  if (!live) {
    throw new Error("Yayın bulunamadı veya aktif değil");
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

  // LiveStream toplam hediye değerini güncelle (atomik)
  await LiveStream.findByIdAndUpdate(live._id, {
    $inc: { totalGiftsValue: gift.valueCoins, totalGiftsCount: 1 },
  });

  // Gift istatistiklerini güncelle (atomik)
  await Gift.findByIdAndUpdate(giftId, {
    $inc: { totalSent: 1, totalCoinsSpent: gift.valueCoins },
  });

  const media = resolveGiftMedia(gift);
  const resolvedImageUrl = media.imageUrl || gift.imageUrl;
  const resolvedAnimationUrl = media.animationUrl || gift.animationUrl;

  // 5. Mesaj olarak kaydet (chat'te görünsün)
  const message = await Message.create({
    roomId: live.roomId,
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
    global.io.to(live.roomId).emit("gift_received", {
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
      roomId: live.roomId,
      timestamp: new Date().toISOString(),
    });
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

// Rate limit cache temizleme (memory leak önleme)
setInterval(
  () => {
    const now = Date.now();
    for (const [key, record] of giftRateLimits.entries()) {
      if (now - record.lastReset > RATE_LIMIT_WINDOW_MS * 2) {
        giftRateLimits.delete(key);
      }
    }
  },
  5 * 60 * 1000,
); // Her 5 dakikada temizle
