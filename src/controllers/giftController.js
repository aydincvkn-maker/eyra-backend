// src/controllers/giftController.js
const giftService = require("../services/giftService");
const Gift = require("../models/Gift");

/**
 * Tüm aktif hediyeleri getir
 */
exports.getGifts = async (req, res) => {
  try {
    const { category } = req.query;
    const gifts = await giftService.getAllGifts(category);
    
    res.json({
      ok: true,
      gifts,
      categories: ["basic", "premium", "vip", "special"]
    });
  } catch (err) {
    console.error("getGifts error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Hediye gönder
 */
exports.sendGift = async (req, res) => {
  try {
    const { giftId, liveId, roomId, recipientId } = req.body;
    const senderId = req.user.id;

    if (!giftId) {
      return res.status(400).json({ ok: false, error: "giftId gerekli" });
    }

    if (!liveId && !roomId) {
      return res.status(400).json({ ok: false, error: "liveId veya roomId gerekli" });
    }

    const result = await giftService.sendGift({
      senderId,
      recipientId,
      giftId,
      liveId,
      roomId
    });

    res.json({
      ok: true,
      message: "Hediye gönderildi",
      data: result
    });
  } catch (err) {
    console.error("sendGift error:", err);
    
    // Bilinen hataları kontrol et
    if (err.message === "Yetersiz coin") {
      return res.status(400).json({ ok: false, error: "insufficient_coins", message: err.message });
    }
    if (err.message.includes("rate") || err.message.includes("hızlı")) {
      return res.status(429).json({ ok: false, error: "rate_limited", message: err.message });
    }
    if (err.message.includes("bulunamadı")) {
      return res.status(404).json({ ok: false, error: "not_found", message: err.message });
    }
    
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Kullanıcının gönderdiği hediye geçmişi
 */
exports.getMyGiftHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50 } = req.query;
    
    const gifts = await giftService.getGiftHistory(userId, parseInt(limit));
    
    res.json({ ok: true, gifts });
  } catch (err) {
    console.error("getMyGiftHistory error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Yayıncının aldığı hediyeler
 */
exports.getReceivedGifts = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50 } = req.query;
    
    const gifts = await giftService.getReceivedGifts(userId, parseInt(limit));
    
    res.json({ ok: true, gifts });
  } catch (err) {
    console.error("getReceivedGifts error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Yayın için hediye istatistikleri
 */
exports.getLiveGiftStats = async (req, res) => {
  try {
    const { liveId } = req.params;
    
    const stats = await giftService.getLiveGiftStats(liveId);
    
    if (!stats) {
      return res.status(404).json({ ok: false, error: "Yayın bulunamadı" });
    }
    
    res.json({ ok: true, stats });
  } catch (err) {
    console.error("getLiveGiftStats error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

// ============ ADMIN ENDPOINTS ============

/**
 * Admin: Yeni hediye oluştur
 */
exports.createGift = async (req, res) => {
  try {
    const giftData = req.body;
    
    if (!giftData.name || !giftData.valueCoins || !giftData.imageUrl) {
      return res.status(400).json({ ok: false, error: "name, valueCoins ve imageUrl gerekli" });
    }
    
    const gift = await giftService.createGift(giftData);
    
    res.status(201).json({ ok: true, gift });
  } catch (err) {
    console.error("createGift error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Admin: Hediye güncelle
 */
exports.updateGift = async (req, res) => {
  try {
    const { giftId } = req.params;
    const updates = req.body;
    
    const gift = await giftService.updateGift(giftId, updates);
    
    if (!gift) {
      return res.status(404).json({ ok: false, error: "Hediye bulunamadı" });
    }
    
    res.json({ ok: true, gift });
  } catch (err) {
    console.error("updateGift error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Admin: Hediye sil
 */
exports.deleteGift = async (req, res) => {
  try {
    const { giftId } = req.params;
    
    const gift = await giftService.deleteGift(giftId);
    
    if (!gift) {
      return res.status(404).json({ ok: false, error: "Hediye bulunamadı" });
    }
    
    res.json({ ok: true, message: "Hediye silindi" });
  } catch (err) {
    console.error("deleteGift error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};

/**
 * Admin: Default hediyeleri seed et
 */
exports.seedGifts = async (req, res) => {
  try {
    await giftService.seedDefaultGifts();
    res.json({ ok: true, message: "Default hediyeler oluşturuldu" });
  } catch (err) {
    console.error("seedGifts error:", err);
    res.status(500).json({ ok: false, error: "Sunucu hatası" });
  }
};
