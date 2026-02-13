const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const SystemSettings = require("../models/SystemSettings");

const getOrCreateSettings = async () => {
  let settings = await SystemSettings.findOne().lean();
  if (!settings) {
    const created = await SystemSettings.create({});
    settings = created.toObject();
  }
  return settings;
};

router.get("/", auth, requirePermission("system:settings"), async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error("❌ settings get error:", err);
    res.status(500).json({ success: false, error: "settings_fetch_failed" });
  }
});

router.put("/", auth, requirePermission("system:settings"), async (req, res) => {
  try {
    const body = req.body || {};
    const update = { updatedBy: req.user?.id || null, updatedAt: new Date() };

    // Tüm boolean alanları
    const booleanFields = [
      "maintenanceMode", "globalSlowMode", "registrationEnabled",
      "guestLoginEnabled", "spinEnabled", "autoModerationEnabled",
      "pushNotificationsEnabled",
    ];
    for (const field of booleanFields) {
      if (typeof body[field] === "boolean") update[field] = body[field];
    }

    // Tüm number alanları
    const numberFields = [
      "maxLoginAttempts", "defaultCoins", "giftCommissionPercent",
      "dailyLoginBonus", "dailySpinLimit", "vipDailySpinLimit",
      "defaultCallPrice", "minCallPrice", "maxCallPrice",
      "maxReportsBeforeAutoBan",
      "vipSilverPrice", "vipGoldPrice", "vipDiamondPrice",
      "vipSilverDays", "vipGoldDays", "vipDiamondDays",
    ];
    for (const field of numberFields) {
      if (typeof body[field] === "number" && Number.isFinite(body[field])) {
        update[field] = body[field];
      }
    }

    // String alanları
    const stringFields = ["minAppVersion"];
    for (const field of stringFields) {
      if (typeof body[field] === "string") update[field] = body[field].trim();
    }

    const settings = await SystemSettings.findOneAndUpdate(
      {},
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({ success: true, settings });
  } catch (err) {
    console.error("❌ settings update error:", err);
    res.status(500).json({ success: false, error: "settings_update_failed" });
  }
});

module.exports = router;
