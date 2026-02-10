const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const LiveStream = require("../models/LiveStream");
const User = require("../models/User");
const mongoose = require("mongoose");

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
    console.error("❌ Stats error:", err);
    res.status(500).json({
      success: false,
      error: "stats_fetch_failed",
    });
  }
});

router.get("/system", auth, requirePermission("system:settings"), async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const dbStatus = dbState === 1 ? "connected" : "disconnected";
    const connectedUsers = global.userSockets?.size ?? 0;
    const activeLives = await LiveStream.countDocuments({ isLive: true, status: "live" });

    res.json({
      uptimeSec: Math.round(process.uptime()),
      db: { state: dbStatus },
      memory: process.memoryUsage(),
      connectedUsers,
      activeLives,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ System stats error:", err);
    res.status(500).json({ success: false, error: "system_stats_failed" });
  }
});

module.exports = router;