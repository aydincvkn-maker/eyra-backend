const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const LiveStream = require("../models/LiveStream");
const User = require("../models/User");
const mongoose = require("mongoose");
const Transaction = require("../models/Transaction");
const { logger } = require("../utils/logger");

router.get("/dashboard", auth, requirePermission("streams:view"), async (req, res) => {
  try {
    const activeLives = await LiveStream.find({ isLive: true, status: "live" })
      .populate("host", "username email")
      .limit(10)
      .lean();

    const totalViewers = activeLives.reduce((sum, live) => sum + (live.viewersCount || live.viewerCount || 0), 0);
    const totalCoinsPerMin = activeLives.reduce(
      (sum, live) => sum + (live.coinsPerMin || Math.round((live.totalGiftsValue || 0) / 10) || 0),
      0
    );
    const onlineHosts = await User.countDocuments({ isOnline: true, isBanned: false });
    const flaggedStreams = await LiveStream.countDocuments({ isFlagged: true, isLive: true });

    const activeStreams = activeLives.map((live) => ({
      id: String(live._id),
      host: live.host?.username || "Unknown",
      viewers: live.viewersCount || live.viewerCount || 0,
      coinsPerMin: live.coinsPerMin || Math.round((live.totalGiftsValue || 0) / 10) || 0,
      title: live.title || "Live"
    }));

    res.json({
      totalViewers,
      totalCoinsPerMin: Math.round(totalCoinsPerMin),
      onlineHosts,
      flaggedStreams,
      activeStreams: activeStreams.slice(0, 5)
    });
    
  } catch (err) {
    logger.error("❌ Stats error:", err);
    res.status(500).json({
      success: false,
      error: "stats_fetch_failed",
    });
  }
});

router.get("/system", auth, requirePermission(["streams:view", "system:settings"]), async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const dbStatus = dbState === 1 ? "connected" : "disconnected";
    const connectedUsers = global.userSockets?.size ?? 0;
    const activeLives = await LiveStream.countDocuments({ isLive: true, status: "live" });
    const env = process.env.NODE_ENV || "development";
    const region =
      process.env.AWS_REGION ||
      process.env.REGION ||
      process.env.DEPLOY_REGION ||
      process.env.CLUSTER ||
      "unknown";

    res.json({
      uptimeSec: Math.round(process.uptime()),
      db: { state: dbStatus },
      memory: process.memoryUsage(),
      connectedUsers,
      activeLives,
      env,
      region,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("❌ System stats error:", err);
    res.status(500).json({ success: false, error: "system_stats_failed" });
  }
});

// ── User Growth & Trends ──
router.get("/users", auth, requirePermission("system:settings"), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "30"), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalUsers, totalBanned, totalOnline, dailySignups] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isBanned: true }),
      User.countDocuments({ isOnline: true }),
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      totalUsers,
      totalBanned,
      totalOnline,
      dailySignups: dailySignups.map(d => ({ date: d._id, count: d.count })),
    });
  } catch (err) {
    logger.error("❌ User stats error:", err);
    res.status(500).json({ success: false, error: "user_stats_failed" });
  }
});

// ── Stream Analytics ──
router.get("/streams", auth, requirePermission("streams:view"), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "7"), 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalStreams, activeNow, dailyStreams, topHosts] = await Promise.all([
      LiveStream.countDocuments({ createdAt: { $gte: since } }),
      LiveStream.countDocuments({ isLive: true, status: "live" }),
      LiveStream.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 }, avgViewers: { $avg: "$peakViewerCount" }, totalGifts: { $sum: "$totalGiftsValue" } } },
        { $sort: { _id: 1 } },
      ]),
      LiveStream.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$host", streamCount: { $sum: 1 }, totalGifts: { $sum: "$totalGiftsValue" }, totalViewers: { $sum: "$peakViewerCount" } } },
        { $sort: { totalGifts: -1 } },
        { $limit: 10 },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, username: "$user.username", streamCount: 1, totalGifts: 1, totalViewers: 1 } },
      ]),
    ]);

    res.json({
      totalStreams,
      activeNow,
      dailyStreams: dailyStreams.map(d => ({ date: d._id, count: d.count, avgViewers: Math.round(d.avgViewers || 0), totalGifts: d.totalGifts })),
      topHosts,
    });
  } catch (err) {
    logger.error("❌ Stream stats error:", err);
    res.status(500).json({ success: false, error: "stream_stats_failed" });
  }
});

// ── Finance Overview ──
router.get("/finance", auth, requirePermission("finance:view"), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "30"), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [dailyRevenue, topEarners] = await Promise.all([
      Transaction.aggregate([
        { $match: { createdAt: { $gte: since }, type: { $in: ["gift", "purchase", "call"] } } },
        { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, type: "$type" }, total: { $sum: "$amount" } } },
        { $sort: { "_id.date": 1 } },
      ]),
      Transaction.aggregate([
        { $match: { createdAt: { $gte: since }, type: { $in: ["gift", "call"] } } },
        { $group: { _id: "$to", totalEarned: { $sum: "$amount" }, txCount: { $sum: 1 } } },
        { $sort: { totalEarned: -1 } },
        { $limit: 10 },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        { $project: { _id: 1, username: "$user.username", totalEarned: 1, txCount: 1 } },
      ]),
    ]);

    // Group daily revenue by date
    const revenueByDate = {};
    for (const r of dailyRevenue) {
      const date = r._id.date;
      if (!revenueByDate[date]) revenueByDate[date] = { date, gift: 0, purchase: 0, call: 0 };
      revenueByDate[date][r._id.type] = r.total;
    }

    res.json({
      dailyRevenue: Object.values(revenueByDate),
      topEarners,
    });
  } catch (err) {
    logger.error("❌ Finance stats error:", err);
    res.status(500).json({ success: false, error: "finance_stats_failed" });
  }
});

module.exports = router;