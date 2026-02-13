// src/services/giftService.js
const Gift = require("../models/Gift");
const User = require("../models/User");
const LiveStream = require("../models/LiveStream");
const Message = require("../models/Message");
const Transaction = require("../models/Transaction");
const { trackMissionProgress } = require("../controllers/missionController");
const { checkGiftSentAchievements, checkGiftReceivedAchievements, checkCoinAchievements } = require("../controllers/achievementController");

// Rate limiting için memory cache
const giftRateLimits = new Map(); // `${userId}:${giftId}` -> { count, lastReset }
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 dakika
const RATE_LIMIT_MAX_GIFTS = 10; // 1 dakikada max 10 aynı hediye

/**
 * Hediye gönderimini rate limit ile kontrol et
 */
const checkRateLimit = (userId, giftId) => {
  const key = `${userId}:${giftId}`;
  const now = Date.now();
  
  let record = giftRateLimits.get(key);
  
  if (!record || (now - record.lastReset) > RATE_LIMIT_WINDOW_MS) {
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
  const query = { isActive: true };
  if (category) query.category = category;
  
  return await Gift.find(query).sort({ order: 1, valueCoins: 1 });
};

/**
 * Hediye gönder - coin düş, yayıncıya ekle
 */
exports.sendGift = async ({ senderId, recipientId, giftId, liveId, roomId }) => {
  // 1. Kullanıcıyı bul
  const sender = await User.findById(senderId);
  if (!sender) {
    throw new Error("Gönderici bulunamadı");
  }
  
  // 2. Hediyeyi bul
  const gift = await Gift.findById(giftId);
  if (!gift || !gift.isActive) {
    throw new Error("Hediye bulunamadı veya aktif değil");
  }
  
  // 3. Rate limit kontrolü
  const rateCheck = checkRateLimit(senderId, giftId);
  if (!rateCheck.allowed) {
    throw new Error("Çok hızlı hediye gönderiyorsunuz. Lütfen bekleyin.");
  }
  
  // 4. Coin kontrolü
  if (sender.coins < gift.valueCoins) {
    throw new Error("Yetersiz coin");
  }
  
  // 5. LiveStream bul (varsa)
  let live = null;
  if (liveId) {
    live = await LiveStream.findById(liveId);
  } else if (roomId) {
    live = await LiveStream.findOne({ roomId, isLive: true });
  }
  
  if (!live) {
    throw new Error("Yayın bulunamadı veya aktif değil");
  }
  
  // 6. Alıcı kontrolü
  const recipient = await User.findById(recipientId || live.host);
  if (!recipient) {
    throw new Error("Alıcı bulunamadı");
  }
  
  // 7. Transaction - coin düşür, ekle
  const actualRecipientId = recipientId || live.host;
  
  // Sender'dan coin düş
  sender.coins -= gift.valueCoins;
  await sender.save();
  
  // Recipient'e coin ekle (%70'i - platform komisyonu %30)
  const recipientShare = Math.floor(gift.valueCoins * 0.7);
  recipient.coins += recipientShare;
  recipient.totalEarnings = (recipient.totalEarnings || 0) + recipientShare;
  await recipient.save();
  
  // LiveStream toplam hediye değerini güncelle
  live.totalGiftsValue = (live.totalGiftsValue || 0) + gift.valueCoins;
  await live.save();
  
  // Gift istatistiklerini güncelle
  gift.totalSent += 1;
  gift.totalCoinsSpent += gift.valueCoins;
  await gift.save();
  
  // 8. Mesaj olarak kaydet (chat'te görünsün)
  const message = await Message.create({
    roomId: live.roomId,
    from: senderId,
    to: actualRecipientId,
    type: "gift",
    content: JSON.stringify({
      giftId: gift._id,
      giftName: gift.name,
      giftImage: gift.imageUrl,
      giftAnimation: gift.animationUrl,
      valueCoins: gift.valueCoins,
      senderName: sender.name || sender.username,
      senderImage: sender.profileImage
    }),
  });
  
  // 9. Socket event emit et
  if (global.io) {
    global.io.to(live.roomId).emit("gift_received", {
      messageId: message._id,
      giftId: gift._id,
      giftName: gift.name,
      giftImage: gift.imageUrl,
      giftAnimation: gift.animationUrl,
      valueCoins: gift.valueCoins,
      senderId: senderId,
      senderName: sender.name || sender.username,
      senderImage: sender.profileImage,
      recipientId: actualRecipientId,
      roomId: live.roomId,
      timestamp: new Date().toISOString()
    });
  }
  
  return {
    success: true,
    message,
    gift: {
      id: gift._id,
      name: gift.name,
      imageUrl: gift.imageUrl,
      animationUrl: gift.animationUrl,
      valueCoins: gift.valueCoins
    },
    senderCoins: sender.coins,
    recipientEarnings: recipientShare
  };
};

// =============================================
// TRANSACTION & MISSION TRACKING (post-gift hooks)
// =============================================

/**
 * Hediye gönderimi sonrası: Transaction kaydet, mission ilerlet, achievement kontrol
 * sendGift fonksiyonundan sonra çağrılır
 */
exports.postGiftHooks = async ({ senderId, recipientId, giftId, giftValue, senderCoins, recipientCoins }) => {
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
    const recipientShare = Math.floor(giftValue * 0.7);
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
    const senderGiftCount = await Message.countDocuments({ from: senderId, type: "gift" });
    await checkGiftSentAchievements(senderId, senderGiftCount);
    await checkGiftReceivedAchievements(recipientId);
    await checkCoinAchievements(senderId, senderCoins);
  } catch (err) {
    console.error("postGiftHooks error:", err);
  }
};

/**
 * Kullanıcının gönderdiği hediye geçmişi
 */
exports.getGiftHistory = async (userId, limit = 50) => {
  return await Message.find({ 
    from: userId, 
    type: "gift" 
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('to', 'username name profileImage');
};

/**
 * Yayıncının aldığı hediyeler
 */
exports.getReceivedGifts = async (userId, limit = 50) => {
  return await Message.find({ 
    to: userId, 
    type: "gift" 
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('from', 'username name profileImage');
};

/**
 * Yayın için hediye istatistikleri
 */
exports.getLiveGiftStats = async (liveId) => {
  const live = await LiveStream.findById(liveId);
  if (!live) return null;
  
  const giftMessages = await Message.find({ 
    roomId: live.roomId, 
    type: "gift" 
  });
  
  let totalValue = 0;
  const giftCounts = {};
  const topSenders = {};
  
  for (const msg of giftMessages) {
    try {
      const content = JSON.parse(msg.content);
      totalValue += content.valueCoins || 0;
      
      // Gift sayısı
      const giftName = content.giftName || 'Unknown';
      giftCounts[giftName] = (giftCounts[giftName] || 0) + 1;
      
      // Top sender
      const senderId = String(msg.from);
      topSenders[senderId] = (topSenders[senderId] || 0) + (content.valueCoins || 0);
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
      .map(([userId, total]) => ({ userId, total }))
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
  return await Gift.findByIdAndUpdate(giftId, { isActive: false }, { new: true });
};

/**
 * Default hediyeleri oluştur (ilk setup için)
 */
exports.seedDefaultGifts = async () => {
  const existingCount = await Gift.countDocuments();
  if (existingCount > 0) {
    console.log("Gifts already seeded");
    return;
  }
  
  const defaultGifts = [
    // Basic
    { name: "Rose", imageUrl: "/gifts/rose.png", valueCoins: 10, category: "basic", order: 1 },
    { name: "Heart", imageUrl: "/gifts/heart.png", valueCoins: 20, category: "basic", order: 2 },
    { name: "Kiss", imageUrl: "/gifts/kiss.png", valueCoins: 30, category: "basic", order: 3 },
    { name: "Lollipop", imageUrl: "/gifts/lollipop.png", valueCoins: 50, category: "basic", order: 4 },
    { name: "Ice Cream", imageUrl: "/gifts/icecream.png", valueCoins: 80, category: "basic", order: 5 },
    
    // Premium
    { name: "Teddy Bear", imageUrl: "/gifts/teddy.png", valueCoins: 100, category: "premium", order: 1 },
    { name: "Perfume", imageUrl: "/gifts/perfume.png", valueCoins: 200, category: "premium", order: 2 },
    { name: "Cake", imageUrl: "/gifts/cake.png", valueCoins: 300, category: "premium", order: 3 },
    { name: "Ring", imageUrl: "/gifts/ring.png", valueCoins: 500, category: "premium", order: 4 },
    
    // VIP
    { name: "Diamond", imageUrl: "/gifts/diamond.png", valueCoins: 1000, category: "vip", order: 1, animationUrl: "/animations/diamond.json" },
    { name: "Crown", imageUrl: "/gifts/crown.png", valueCoins: 2000, category: "vip", order: 2, animationUrl: "/animations/crown.json" },
    { name: "Rocket", imageUrl: "/gifts/rocket.png", valueCoins: 5000, category: "vip", order: 3, animationUrl: "/animations/rocket.json" },
    { name: "Castle", imageUrl: "/gifts/castle.png", valueCoins: 10000, category: "vip", order: 4, animationUrl: "/animations/castle.json" },
    
    // Special
    { name: "Fireworks", imageUrl: "/gifts/fireworks.png", valueCoins: 20000, category: "special", order: 1, animationUrl: "/animations/fireworks.json" },
    { name: "Yacht", imageUrl: "/gifts/yacht.png", valueCoins: 50000, category: "special", order: 2, animationUrl: "/animations/yacht.json" },
    { name: "Private Jet", imageUrl: "/gifts/jet.png", valueCoins: 100000, category: "special", order: 3, animationUrl: "/animations/jet.json" },
  ];
  
  await Gift.insertMany(defaultGifts);
  console.log("✅ Default gifts seeded:", defaultGifts.length);
};

// Rate limit cache temizleme (memory leak önleme)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of giftRateLimits.entries()) {
    if (now - record.lastReset > RATE_LIMIT_WINDOW_MS * 2) {
      giftRateLimits.delete(key);
    }
  }
}, 5 * 60 * 1000); // Her 5 dakikada temizle
