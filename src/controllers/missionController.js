// src/controllers/missionController.js
const Mission = require("../models/Mission");
const MissionProgress = require("../models/MissionProgress");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { createNotification } = require("./notificationController");

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Günlük görev dönemi hesapla
 */
const getDailyPeriod = () => {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

/**
 * Haftalık görev dönemi hesapla (Pazartesi başlangıç)
 */
const getWeeklyPeriod = () => {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Pazartesi = 0
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - diff);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
};

/**
 * Görev ilerleme dönemi
 */
const getPeriodForMission = (missionType) => {
  switch (missionType) {
    case "daily":
      return getDailyPeriod();
    case "weekly":
      return getWeeklyPeriod();
    case "one_time":
    case "milestone":
      return {
        start: new Date("2020-01-01"),
        end: new Date("2099-12-31"),
      };
    default:
      return getDailyPeriod();
  }
};

// =============================================
// GÖREV İLERLEME SİSTEMİ
// =============================================

/**
 * Görev ilerleme güncelle (diğer controller'lardan çağrılır)
 * Örnek: trackMissionProgress(userId, 'send_gift', 1)
 */
exports.trackMissionProgress = async (userId, missionKey, incrementBy = 1) => {
  try {
    // Bu anahtara sahip aktif görevleri bul
    const missions = await Mission.find({ key: missionKey, isActive: true });
    if (missions.length === 0) return;

    for (const mission of missions) {
      const period = getPeriodForMission(mission.type);

      // Upsert: varsa güncelle, yoksa oluştur
      const progress = await MissionProgress.findOneAndUpdate(
        {
          user: userId,
          mission: mission._id,
          periodStart: period.start,
        },
        {
          $inc: { currentCount: incrementBy },
          $setOnInsert: {
            missionKey: mission.key,
            targetCount: mission.targetCount,
            periodEnd: period.end,
          },
        },
        { upsert: true, new: true }
      );

      // Tamamlandı mı kontrol et
      if (
        !progress.isCompleted &&
        progress.currentCount >= progress.targetCount
      ) {
        await MissionProgress.findByIdAndUpdate(progress._id, {
          $set: { isCompleted: true, completedAt: new Date() },
        });

        // Bildirim gönder
        await createNotification({
          recipientId: userId,
          type: "mission_completed",
          title: "Görev Tamamlandı! 🎉",
          titleEn: "Mission Completed! 🎉",
          body: `"${mission.title}" görevini tamamladın!`,
          bodyEn: `You completed "${mission.titleEn || mission.title}"!`,
          actionData: { missionId: String(mission._id) },
        });
      }
    }
  } catch (err) {
    console.error("trackMissionProgress error:", err);
  }
};

// =============================================
// API ENDPOINTS
// =============================================

// GET /api/missions - Aktif görevleri getir (ilerleme ile birlikte)
exports.getMissions = async (req, res) => {
  try {
    const userId = req.user.id;
    const type = req.query.type; // 'daily', 'weekly', 'one_time', 'milestone'

    const missionQuery = { isActive: true };
    if (type) missionQuery.type = type;

    const missions = await Mission.find(missionQuery)
      .sort({ order: 1 })
      .lean();

    // Her görev için kullanıcının ilerlemesini getir
    const missionsWithProgress = await Promise.all(
      missions.map(async (mission) => {
        const period = getPeriodForMission(mission.type);

        const progress = await MissionProgress.findOne({
          user: userId,
          mission: mission._id,
          periodStart: period.start,
        }).lean();

        return {
          _id: mission._id,
          key: mission.key,
          title: mission.title,
          titleEn: mission.titleEn,
          description: mission.description,
          descriptionEn: mission.descriptionEn,
          icon: mission.icon,
          type: mission.type,
          category: mission.category,
          targetCount: mission.targetCount,
          rewardCoins: mission.rewardCoins,
          rewardXP: mission.rewardXP,
          // İlerleme bilgisi
          currentCount: progress?.currentCount || 0,
          isCompleted: progress?.isCompleted || false,
          isRewardClaimed: progress?.isRewardClaimed || false,
          completedAt: progress?.completedAt || null,
        };
      })
    );

    res.json({ success: true, missions: missionsWithProgress });
  } catch (err) {
    console.error("getMissions error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/missions/:missionId/claim - Görev ödülünü talep et
exports.claimReward = async (req, res) => {
  try {
    const userId = req.user.id;
    const { missionId } = req.params;

    const mission = await Mission.findById(missionId);
    if (!mission) {
      return res.status(404).json({ success: false, message: "Görev bulunamadı" });
    }

    const period = getPeriodForMission(mission.type);
    const progress = await MissionProgress.findOne({
      user: userId,
      mission: missionId,
      periodStart: period.start,
    });

    if (!progress) {
      return res.status(400).json({ success: false, message: "Görev ilerlemeniz yok" });
    }

    if (!progress.isCompleted) {
      return res.status(400).json({ success: false, message: "Görev henüz tamamlanmadı" });
    }

    if (progress.isRewardClaimed) {
      return res.status(400).json({ success: false, message: "Ödül zaten alındı" });
    }

    // Ödül ver
    const updateData = {};
    if (mission.rewardCoins > 0) {
      updateData.$inc = { coins: mission.rewardCoins };
    }
    if (mission.rewardXP > 0) {
      updateData.$inc = {
        ...updateData.$inc,
        xp: mission.rewardXP,
        totalXpEarned: mission.rewardXP,
      };
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
    }).select("coins xp level");

    // Seviye kontrolü
    if (mission.rewardXP > 0 && updatedUser) {
      const newLevel = updatedUser.calculateLevel();
      if (newLevel !== updatedUser.level) {
        await User.findByIdAndUpdate(userId, { $set: { level: newLevel } });
      }
    }

    // İlerleme güncelle
    await MissionProgress.findByIdAndUpdate(progress._id, {
      $set: { isRewardClaimed: true, rewardClaimedAt: new Date() },
    });

    // Transaction kaydet
    if (mission.rewardCoins > 0) {
      await Transaction.create({
        user: userId,
        type: "mission_reward",
        amount: mission.rewardCoins,
        balanceAfter: updatedUser?.coins || 0,
        relatedMission: mission._id,
        description: `${mission.title} görev ödülü`,
      });
    }

    res.json({
      success: true,
      message: "Ödül alındı!",
      reward: {
        coins: mission.rewardCoins,
        xp: mission.rewardXP,
      },
      newBalance: updatedUser?.coins || 0,
    });
  } catch (err) {
    console.error("claimReward error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ADMIN ENDPOINTS
// =============================================

// GET /api/missions/admin/all - Tüm görevleri listele (admin)
exports.adminGetMissions = async (req, res) => {
  try {
    const missions = await Mission.find().sort({ type: 1, order: 1 }).lean();
    res.json({ success: true, missions });
  } catch (err) {
    console.error("adminGetMissions error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/missions/admin - Yeni görev oluştur (admin)
exports.adminCreateMission = async (req, res) => {
  try {
    const mission = await Mission.create(req.body);
    res.json({ success: true, mission });
  } catch (err) {
    console.error("adminCreateMission error:", err);
    res.status(500).json({ success: false, message: "Görev oluşturulamadı" });
  }
};

// PUT /api/missions/admin/:missionId - Görev güncelle (admin)
exports.adminUpdateMission = async (req, res) => {
  try {
    const { missionId } = req.params;
    const mission = await Mission.findByIdAndUpdate(
      missionId,
      { $set: req.body },
      { new: true }
    );
    if (!mission) {
      return res.status(404).json({ success: false, message: "Görev bulunamadı" });
    }
    res.json({ success: true, mission });
  } catch (err) {
    console.error("adminUpdateMission error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/missions/admin/:missionId - Görev sil (admin)
exports.adminDeleteMission = async (req, res) => {
  try {
    const { missionId } = req.params;
    await Mission.findByIdAndDelete(missionId);
    await MissionProgress.deleteMany({ mission: missionId });
    res.json({ success: true, message: "Görev silindi" });
  } catch (err) {
    console.error("adminDeleteMission error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/missions/admin/seed - Varsayılan görevleri oluştur
exports.seedMissions = async (req, res) => {
  try {
    const existingCount = await Mission.countDocuments();
    if (existingCount > 0) {
      return res.json({
        success: false,
        message: `Zaten ${existingCount} görev mevcut. Seed için önce görevleri silin.`,
      });
    }

    const defaultMissions = [
      // Günlük görevler  
      { key: "daily_login", title: "Günlük Giriş", titleEn: "Daily Login", description: "Uygulamaya giriş yap", descriptionEn: "Log in to the app", icon: "📱", type: "daily", category: "engagement", targetCount: 1, rewardCoins: 50, rewardXP: 10, order: 1 },
      { key: "send_message", title: "Mesaj Gönder", titleEn: "Send Message", description: "3 farklı kişiye mesaj gönder", descriptionEn: "Send messages to 3 different people", icon: "💬", type: "daily", category: "social", targetCount: 3, rewardCoins: 30, rewardXP: 15, order: 2 },
      { key: "watch_stream", title: "Yayın İzle", titleEn: "Watch Stream", description: "Bir canlı yayın izle", descriptionEn: "Watch a live stream", icon: "📺", type: "daily", category: "streaming", targetCount: 1, rewardCoins: 40, rewardXP: 20, order: 3 },
      { key: "send_gift", title: "Hediye Gönder", titleEn: "Send Gift", description: "Bir hediye gönder", descriptionEn: "Send a gift", icon: "🎁", type: "daily", category: "gifting", targetCount: 1, rewardCoins: 20, rewardXP: 25, order: 4 },
      { key: "make_call", title: "Görüntülü Ara", titleEn: "Make a Call", description: "Bir görüntülü arama yap", descriptionEn: "Make a video call", icon: "📹", type: "daily", category: "social", targetCount: 1, rewardCoins: 50, rewardXP: 30, order: 5 },
      
      // Haftalık görevler
      { key: "weekly_stream", title: "Haftalık Yayıncı", titleEn: "Weekly Streamer", description: "Haftada 3 kez yayın yap", descriptionEn: "Stream 3 times this week", icon: "🎙️", type: "weekly", category: "streaming", targetCount: 3, rewardCoins: 200, rewardXP: 100, order: 10 },
      { key: "weekly_social", title: "Sosyal Kelebek", titleEn: "Social Butterfly", description: "Haftada 10 farklı kişiyle sohbet et", descriptionEn: "Chat with 10 different people", icon: "🦋", type: "weekly", category: "social", targetCount: 10, rewardCoins: 150, rewardXP: 80, order: 11 },
      { key: "weekly_gifter", title: "Cömert Ruh", titleEn: "Generous Spirit", description: "Haftada 5 hediye gönder", descriptionEn: "Send 5 gifts this week", icon: "💝", type: "weekly", category: "gifting", targetCount: 5, rewardCoins: 100, rewardXP: 50, order: 12 },

      // Milestone görevler (bir kere)
      { key: "first_stream", title: "İlk Yayın", titleEn: "First Stream", description: "İlk canlı yayınını yap", descriptionEn: "Start your first live stream", icon: "⭐", type: "one_time", category: "milestone", targetCount: 1, rewardCoins: 500, rewardXP: 200, order: 20 },
      { key: "first_gift", title: "İlk Hediye", titleEn: "First Gift", description: "İlk hediyeni gönder", descriptionEn: "Send your first gift", icon: "🎀", type: "one_time", category: "milestone", targetCount: 1, rewardCoins: 100, rewardXP: 50, order: 21 },
      { key: "reach_level_5", title: "Seviye 5", titleEn: "Level 5", description: "Seviye 5'e ulaş", descriptionEn: "Reach level 5", icon: "🏆", type: "milestone", category: "milestone", targetCount: 1, rewardCoins: 1000, rewardXP: 0, order: 22 },
      { key: "reach_level_10", title: "Seviye 10", titleEn: "Level 10", description: "Seviye 10'a ulaş", descriptionEn: "Reach level 10", icon: "👑", type: "milestone", category: "milestone", targetCount: 1, rewardCoins: 5000, rewardXP: 0, order: 23 },
      { key: "100_followers", title: "100 Takipçi", titleEn: "100 Followers", description: "100 takipçiye ulaş", descriptionEn: "Reach 100 followers", icon: "🌟", type: "milestone", category: "social", targetCount: 1, rewardCoins: 2000, rewardXP: 500, order: 24 },
    ];

    await Mission.insertMany(defaultMissions);
    res.json({ success: true, message: `${defaultMissions.length} görev oluşturuldu`, count: defaultMissions.length });
  } catch (err) {
    console.error("seedMissions error:", err);
    res.status(500).json({ success: false, message: "Seed başarısız" });
  }
};
