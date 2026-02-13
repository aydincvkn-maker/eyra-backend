const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const vipController = require("../controllers/vipController");

// User routes
router.get("/packages", auth, vipController.getVipPackages);
router.get("/status", auth, vipController.getVipStatus);
router.post("/purchase", auth, vipController.purchaseVip);

// Admin routes
router.post("/admin/set", auth, admin, vipController.adminSetVip);

module.exports = router;
