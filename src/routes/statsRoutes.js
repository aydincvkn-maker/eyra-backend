const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const LiveStream = require("../models/LiveStream");
const User = require("../models/User");

router.get("/dashboard", auth, admin, async (req, res) => {
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

    // Sahte veri döndürme: hata varsa boş stats gönder
    res.status(200).json({
      totalViewers: 0,
      totalCoinsPerMin: 0,
      onlineHosts: 0,
      flaggedStreams: 0,
      activeStreams: []
    });
  }
});

module.exports = router;