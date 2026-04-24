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

const GIFT_MEDIA_BY_KEY = {
  rose: { imageUrl: "/gifts/hrt.jpg", animationUrl: "/videos/gifts/rose.mp4" },
  fireworks: {
    imageUrl: "/gifts/red.jpg",
    animationUrl: "/videos/gifts/fire.mp4",
  },
  heart: {
    imageUrl: "/gifts/hrt.jpg",
    animationUrl: "/videos/gifts/heart.mp4",
  },
  boxes: { imageUrl: "/gifts/box.webp", animationUrl: "/videos/gifts/box.mp4" },
  teddy: {
    imageUrl: "/gifts/red.jpg",
    animationUrl: "/videos/gifts/teddy.mp4",
  },
  perfume: {
    imageUrl: "/gifts/red.jpg",
    animationUrl: "/videos/gifts/perf.mp4",
  },
  chest: {
    imageUrl: "/gifts/chest.jpg",
    animationUrl: "/videos/gifts/chest.mp4",
  },
  ring: { imageUrl: "/gifts/chb.jpg", animationUrl: "/videos/gifts/ring.mp4" },
  diamond: {
    imageUrl: "/gifts/elf.jpg",
    animationUrl: "/videos/gifts/diamond.mp4",
  },
  castle: {
    imageUrl: "/gifts/box.webp",
    animationUrl: "/videos/gifts/castle.mp4",
  },
  angel: {
    imageUrl: "/gifts/ang.jpg",
    animationUrl: "/videos/gifts/angel.mp4",
  },
  new_gift1: {
    imageUrl: "/gifts/new_gift1.jpg",
    animationUrl: null,
  },
  new_gift2: {
    imageUrl: "/gifts/new_gift2.jpg",
    animationUrl: null,
  },
  new_gift3: {
    imageUrl: "/gifts/new_gift3.jpg",
    animationUrl: null,
  },
};

const normalizeGiftKey = (gift) => {
  const image = (gift?.imageUrl || "").toLowerCase();
  const name = (gift?.name || "").toLowerCase();

  if (image.includes("rose") || name.includes("gül") || name.includes("rose"))
    return "rose";
  if (
    image.includes("fire") ||
    name.includes("havai") ||
    name.includes("fişek")
  )
    return "fireworks";
  if (
    image.includes("heart") ||
    name.includes("kalp") ||
    name.includes("heart")
  )
    return "heart";
  if (
    image.includes("gift_boxes") ||
    image.includes("box") ||
    name.includes("kutu") ||
    name.includes("box")
  )
    return "boxes";
  if (image.includes("teddy") || name.includes("ayı") || name.includes("teddy"))
    return "teddy";
  if (
    image.includes("perfume") ||
    name.includes("parfüm") ||
    name.includes("perfume")
  )
    return "perfume";
  if (
    image.includes("magic_chest") ||
    image.includes("chest") ||
    name.includes("sandık") ||
    name.includes("chest")
  )
    return "chest";
  if (image.includes("ring") || name.includes("yüzük") || name.includes("ring"))
    return "ring";
  if (
    image.includes("diamond") ||
    name.includes("elmas") ||
    name.includes("diamond")
  )
    return "diamond";
  if (
    image.includes("castle") ||
    name.includes("kale") ||
    name.includes("castle")
  )
    return "castle";
  if (
    image.includes("angel") ||
    name.includes("melek") ||
    name.includes("angel")
  )
    return "angel";
  if (image.includes("new_gift1") || name.includes("new_gift1"))
    return "new_gift1";
  if (image.includes("new_gift2") || name.includes("new_gift2"))
    return "new_gift2";
  if (image.includes("new_gift3") || name.includes("new_gift3"))
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

const DEFAULT_GIFTS = [
  {
    name: "Gül",
    description: "Sevimli bir gül hediyesi",
    imageUrl: "/gifts/hrt.jpg",
    animationUrl: "/videos/gifts/rose.mp4",
    valueCoins: 10,
    category: "basic",
    order: 1,
  },
  {
    name: "Havai Fişek",
    description: "Ateşli bir hediye",
    imageUrl: "/gifts/red.jpg",
    animationUrl: "/videos/gifts/fire.mp4",
    valueCoins: 50,
    category: "basic",
    order: 2,
  },
  {
    name: "Kalp",
    description: "Tatlı kalp hediyesi",
    imageUrl: "/gifts/hrt.jpg",
    animationUrl: "/videos/gifts/heart.mp4",
    valueCoins: 25,
    category: "basic",
    order: 3,
  },
  {
    name: "Kutular",
    description: "Pembe hediye kutuları",
    imageUrl: "/gifts/box.webp",
    animationUrl: "/videos/gifts/box.mp4",
    valueCoins: 75,
    category: "basic",
    order: 4,
  },
  {
    name: "Ayıcık",
    description: "Sevimli peluş ayıcık",
    imageUrl: "/gifts/red.jpg",
    animationUrl: "/videos/gifts/teddy.mp4",
    valueCoins: 200,
    category: "premium",
    order: 1,
  },
  {
    name: "Parfüm",
    description: "Lüks bir parfüm",
    imageUrl: "/gifts/red.jpg",
    animationUrl: "/videos/gifts/perf.mp4",
    valueCoins: 500,
    category: "premium",
    order: 2,
  },
  {
    name: "Sandık",
    description: "Mavi sihirli sandık",
    imageUrl: "/gifts/chest.jpg",
    valueCoins: 1200,
    category: "premium",
    order: 3,
    animationUrl: "/videos/gifts/chest.mp4",
  },
  {
    name: "Yüzük",
    description: "Altın yüzük",
    imageUrl: "/gifts/chb.jpg",
    animationUrl: "/videos/gifts/ring.mp4",
    valueCoins: 2000,
    category: "vip",
    order: 1,
  },
  {
    name: "Elmas",
    description: "Pırlanta elmas",
    imageUrl: "/gifts/elf.jpg",
    valueCoins: 5000,
    category: "vip",
    order: 2,
    animationUrl: "/videos/gifts/diamond.mp4",
  },
  {
    name: "Kale",
    description: "Muhteşem bir kale",
    imageUrl: "/gifts/box.webp",
    valueCoins: 50000,
    category: "special",
    order: 1,
    animationUrl: "/videos/gifts/castle.mp4",
  },
  {
    name: "Melek",
    description: "Parlayan melek hediyesi",
    imageUrl: "/gifts/ang.jpg",
    animationUrl: "/videos/gifts/angel.mp4",
    valueCoins: 15000,
    category: "special",
    order: 2,
  },
  {
    name: "Özel Hediye 1",
    description: "Özel hediye",
    imageUrl: "/gifts/new_gift1.jpg",
    valueCoins: 100,
    category: "basic",
    order: 5,
  },
  {
    name: "Özel Hediye 2",
    description: "Özel hediye",
    imageUrl: "/gifts/new_gift2.jpg",
    valueCoins: 300,
    category: "premium",
    order: 4,
  },
  {
    name: "Özel Hediye 3",
    description: "Özel hediye",
    imageUrl: "/gifts/new_gift3.jpg",
    valueCoins: 800,
    category: "premium",
    order: 5,
  },
];

const syncDefaultGifts = async () => {
  const existingGifts = await Gift.find({}, "name imageUrl").lean();
  const existingKeys = new Set(
    existingGifts.flatMap((gift) => [gift.name, gift.imageUrl].filter(Boolean)),
  );

  const missingGifts = DEFAULT_GIFTS.filter(
    (gift) => !existingKeys.has(gift.name) && !existingKeys.has(gift.imageUrl),
  );

  if (missingGifts.length === 0) {
    return 0;
  }

  await Gift.insertMany(missingGifts);
  logger.info("Default gifts synced:", missingGifts.length);
  return missingGifts.length;
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

  const query = { isActive: true, name: periGiftPayload.name };
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
