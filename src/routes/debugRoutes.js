const express = require("express");

const router = express.Router();

const User = require("../models/User");
const { normalizeGender } = require("../utils/gender");
const { PORT } = require("../config/env");
const presenceService = require("../services/presenceService");

// ✅ DEBUG ENDPOINTS
router.get("/test", (req, res) => {
  res.json({
    status: "OK",
    message: "Backend çalışıyor",
    timestamp: new Date().toISOString(),
    port: PORT,
  });
});

router.get("/user-counts", async (req, res) => {
  try {
    const total = await User.countDocuments({});
    const notBanned = await User.countDocuments({ isBanned: { $ne: true } });
    const females = await User.countDocuments({ gender: "female", isBanned: { $ne: true } });
    const males = await User.countDocuments({ gender: "male", isBanned: { $ne: true } });

    res.json({
      total,
      notBanned,
      females,
      males,
      visibleForGuest: females,
      visibleForFemaleViewer: notBanned - 1,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/socket-status", (req, res) => {
  const io = global.io;
  const userSockets = global.userSockets;
  const metrics = presenceService.getMetrics ? presenceService.getMetrics() : null;

  res.json({
    connectedSockets: io?.engine?.clientsCount ?? 0,
    connectedUsers: userSockets?.size ?? 0,
    activeCalls: global.activeCalls?.size ?? 0,
    pendingCalls: global.pendingCalls?.size ?? 0,
    presenceMetrics: metrics,
    userSocketMap: userSockets
      ? Array.from(userSockets.entries()).map(([userId, sockets]) => ({
          userId,
          socketCount: sockets.size,
        }))
      : [],
    timestamp: new Date().toISOString(),
  });
});

router.get("/presence", async (req, res) => {
  try {
    const onlineUsers = await presenceService.getOnlineUsers();
    const metrics = presenceService.getMetrics ? presenceService.getMetrics() : null;
    
    res.json({
      totalOnline: onlineUsers.length,
      users: onlineUsers,
      metrics: metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ SADECE GOOGLE/APPLE İLE KAYITLI OLMAYAN TEST KULLANICILARI SİL
router.delete("/delete-fake-users", async (req, res) => {
  try {
    const result = await User.deleteMany({
      $or: [
        { email: { $regex: /test/i } },
        { email: { $regex: /fake/i } },
        { email: { $regex: /demo/i } },
        { username: { $regex: /test/i } },
        { username: { $regex: /fake/i } },
        { username: { $regex: /demo/i } },
      ],
    });

    const remainingUsers = await User.find().select("username email gender");

    res.json({
      success: true,
      message: `${result.deletedCount} fake kullanıcı silindi`,
      remainingUsers: remainingUsers.length,
      users: remainingUsers,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ TÜM KULLANICILARI LİSTELE (Debugging için)
router.get("/list-all-users", async (req, res) => {
  try {
    const users = await User.find().select("username email gender age isOnline isLive createdAt");

    res.json({
      success: true,
      totalUsers: users.length,
      users: users,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ ONLINE/OFFLINE STATÜSÜNÜ KONTROL ET
router.get("/check-online-status", async (req, res) => {
  try {
    // Veritabanından - DB durumu
    const dbOnlineUsers = await User.find({ isOnline: true })
      .select("username email gender isOnline isLive isBusy lastOnlineAt lastOfflineAt");
    
    const dbLiveUsers = await User.find({ isLive: true })
      .select("username email gender isLive isOnline");

    // Bellekten - Socket durumu
    const memoryOnlineUsers = await presenceService.getOnlineUsers();

    res.json({
      success: true,
      database: {
        onlineCount: dbOnlineUsers.length,
        liveCount: dbLiveUsers.length,
        onlineUsers: dbOnlineUsers,
        liveUsers: dbLiveUsers,
      },
      memory: {
        onlineCount: memoryOnlineUsers.length,
        onlineUsers: memoryOnlineUsers,
      },
      timestamp: new Date().toISOString(),
      note: "DB ve Memory arasında uyumsuzluk varsa, socket'ler bağlantısız demektir",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ TÜM KULLANICILARI OFFLINE YAP (Force reset)
router.post("/reset-all-offline", async (req, res) => {
  try {
    const result = await User.updateMany(
      {},
      {
        $set: {
          isOnline: false,
          isBusy: false,
          isLive: false,
          lastOfflineAt: new Date(),
        }
      }
    );

    res.json({
      success: true,
      message: `${result.modifiedCount} kullanıcı offline yapıldı`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ KULLANICI CİNSİYETİNİ DEĞİŞTİR
router.post("/update-user-gender", async (req, res) => {
  try {
    const { email, gender } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !gender) {
      return res.status(400).json({ success: false, message: "Email ve gender gerekli" });
    }

    const normalizedGender = normalizeGender(gender);

    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { $set: { gender: normalizedGender } },
      { new: true }
    ).select("username email gender");

    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    res.json({
      success: true,
      message: `${user.username} cinsiyet güncellendi: ${gender}`,
      user,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ GUEST KULLANICILARI SİL
router.delete("/delete-guest-users", async (req, res) => {
  try {
    const result = await User.deleteMany({
      email: { $regex: /@guest\.(com|local)/i },
    });

    const remaining = await User.find().select("username email gender");

    res.json({
      success: true,
      message: `${result.deletedCount} guest kullanıcı silindi`,
      remainingUsers: remaining.length,
      users: remaining,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
