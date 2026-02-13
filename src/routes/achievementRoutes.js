// src/routes/achievementRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const achievementController = require("../controllers/achievementController");

// Kullanıcı endpoint'leri
router.get("/", auth, achievementController.getAchievements);
router.get("/recent", auth, achievementController.getRecentAchievements);

module.exports = router;
