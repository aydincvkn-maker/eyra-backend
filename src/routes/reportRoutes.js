const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const Report = require("../models/Report");

// Tüm raporları getir (admin only) + pagination
router.get("/", auth, admin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50"), 1), 200);
    const status = String(req.query.status || "all").trim();
    const search = String(req.query.search || "").trim();

    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Report.find(query)
        .populate("reporter", "username email")
        .populate("target", "username email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Report.countDocuments(query),
    ]);

    const normalized = items
      .map((r) => ({
        _id: r._id,
        reporter: r.reporter?.username || r.reporter?.email || "Unknown",
        reporterId: r.reporter?._id || null,
        target: r.target?.username || r.target?.email || "Unknown",
        targetId: r.target?._id || null,
        reason: r.reason || "",
        status: r.status || "open",
        createdAt: r.createdAt,
        roomId: r.roomId || null,
      }))
      .filter((r) => {
        if (!search) return true;
        const hay = `${r.reporter} ${r.target} ${r.reason} ${r.roomId || ""}`
          .toLowerCase();
        return hay.includes(search.toLowerCase());
      });

    res.json({
      success: true,
      reports: normalized,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("❌ report list error:", err);
    res.status(500).json({ success: false, error: "report_list_failed" });
  }
});

// Rapor durumunu güncelle (admin only)
router.put("/:id", auth, admin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    const updated = await Report.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true }
    )
      .populate("reporter", "username email")
      .populate("target", "username email")
      .lean();

    if (!updated) return res.status(404).json({ message: "Rapor bulunamadı" });

    res.json({
      success: true,
      report: {
        _id: updated._id,
        reporter: updated.reporter?.username || updated.reporter?.email || "Unknown",
        target: updated.target?.username || updated.target?.email || "Unknown",
        reason: updated.reason || "",
        status: updated.status || "open",
        createdAt: updated.createdAt,
        roomId: updated.roomId || null,
      }
    });
  } catch (err) {
    console.error("❌ report update error:", err);
    res.status(500).json({ success: false, error: "report_update_failed" });
  }
});

// Rapor sil (admin only)
router.delete("/:id", auth, admin, async (req, res) => {
  try {
    const id = req.params.id;
    await Report.deleteOne({ _id: id });

    res.json({ success: true, message: "Silindi" });
  } catch (err) {
    console.error("❌ report delete error:", err);
    res.status(500).json({ success: false, error: "report_delete_failed" });
  }
});

module.exports = router;
