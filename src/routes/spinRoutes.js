// src/routes/spinRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const spinController = require("../controllers/spinController");

// Kullanıcı endpoint'leri
router.get("/rewards", auth, spinController.getRewards);
router.get("/status", auth, spinController.getSpinStatus);
router.post("/spin", auth, spinController.spin);

// Admin endpoint'leri
router.get("/admin/rewards", auth, requirePermission("system:settings"), spinController.adminGetRewards);
router.post("/admin/rewards", auth, requirePermission("system:settings"), spinController.adminCreateReward);
router.put("/admin/rewards/:rewardId", auth, requirePermission("system:settings"), spinController.adminUpdateReward);
router.delete("/admin/rewards/:rewardId", auth, requirePermission("system:settings"), spinController.adminDeleteReward);
router.post("/admin/seed", auth, requirePermission("system:settings"), spinController.seedRewards);

module.exports = router;
