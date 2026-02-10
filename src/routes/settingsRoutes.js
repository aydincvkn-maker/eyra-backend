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
    const { maintenanceMode, globalSlowMode } = req.body || {};

    const update = { updatedBy: req.user?.id || null, updatedAt: new Date() };
    if (typeof maintenanceMode === "boolean") update.maintenanceMode = maintenanceMode;
    if (typeof globalSlowMode === "boolean") update.globalSlowMode = globalSlowMode;

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
