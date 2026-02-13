const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const vipController = require("../controllers/vipController");

// User routes
router.get("/packages", authMiddleware, vipController.getVipPackages);
router.get("/status", authMiddleware, vipController.getVipStatus);
router.post("/purchase", authMiddleware, vipController.purchaseVip);

// Admin routes
router.post("/admin/set", authMiddleware, adminMiddleware, vipController.adminSetVip);

module.exports = router;
