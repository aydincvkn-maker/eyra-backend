// src/routes/missionRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const missionController = require("../controllers/missionController");

// Kullanıcı endpoint'leri
router.get("/", auth, missionController.getMissions);
router.post("/:missionId/claim", auth, missionController.claimReward);

// Admin endpoint'leri
router.get("/admin/all", auth, requirePermission("system:settings"), missionController.adminGetMissions);
router.post("/admin", auth, requirePermission("system:settings"), missionController.adminCreateMission);
router.put("/admin/:missionId", auth, requirePermission("system:settings"), missionController.adminUpdateMission);
router.delete("/admin/:missionId", auth, requirePermission("system:settings"), missionController.adminDeleteMission);
router.post("/admin/seed", auth, requirePermission("system:settings"), missionController.seedMissions);

module.exports = router;
