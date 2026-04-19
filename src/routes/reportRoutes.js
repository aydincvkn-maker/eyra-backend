const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const Report = require("../models/Report");
const { sendError } = require("../utils/response");
const adminSocket = require("../socket/adminNamespace");
const { logger } = require("../utils/logger");

const { reportLimiter } = require("../middleware/rateLimit");

// Tüm raporları getir (admin only) + pagination
router.get("/", auth, requirePermission("reports:view"), async (req, res) => {
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

    let items = [];
    let total = 0;

    if (search) {
      const regex = new RegExp(search, "i");

      const pipeline = [
        { $match: query },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "reporter",
            foreignField: "_id",
            as: "reporter",
          },
        },
        { $unwind: { path: "$reporter", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "users",
            localField: "target",
            foreignField: "_id",
            as: "target",
          },
        },
        { $unwind: { path: "$target", preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $or: [
              { reason: regex },
              { roomId: regex },
              { "reporter.username": regex },
              { "reporter.email": regex },
              { "target.username": regex },
              { "target.email": regex },
            ],
          },
        },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        },
      ];

      const result = await Report.aggregate(pipeline);
      const bucket = result?.[0] || {};
      items = bucket.items || [];
      total = bucket.total?.[0]?.count || 0;
    } else {
      const [rawItems, rawTotal] = await Promise.all([
        Report.find(query)
          .populate("reporter", "username email")
          .populate("target", "username email")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Report.countDocuments(query),
      ]);

      items = rawItems;
      total = rawTotal;
    }

    const normalized = items.map((r) => ({
      _id: r._id,
      reporter: r.reporter?.username || r.reporter?.email || "Unknown",
      reporterId: r.reporter?._id || null,
      target: r.target?.username || r.target?.email || "Unknown",
      targetId: r.target?._id || null,
      reason: r.reason || "",
      status: r.status || "open",
      createdAt: r.createdAt,
      roomId: r.roomId || null,
    }));

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
    logger.error("❌ report list error:", err);
    res.status(500).json({ success: false, error: "report_list_failed" });
  }
});

// Rapor oluştur (user endpoint — kullanıcılar şikayet gönderir)
router.post("/", auth, reportLimiter, async (req, res) => {
  try {
    const { targetId, reason, roomId, type } = req.body;
    const reporterId = req.user.id;

    if (!targetId || !reason) {
      return sendError(res, 400, "targetId ve reason gerekli");
    }

    // Aynı kullanıcıyı son 1 saatte tekrar şikayet edemez
    const recentDuplicate = await Report.findOne({
      reporter: reporterId,
      target: targetId,
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
    });
    if (recentDuplicate) {
      return sendError(res, 429, "Bu kullanıcıyı zaten kısa süre önce şikayet ettiniz");
    }

    const report = await Report.create({
      reporter: reporterId,
      target: targetId,
      reason: String(reason).slice(0, 500),
      roomId: roomId || null,
      type: type || "user",
      status: "open",
    });

    res.status(201).json({ success: true, reportId: report._id });

    // Notify admin sockets
    adminSocket.emit("report:created", { reportId: report._id, targetId, reason: report.reason, type: report.type });
  } catch (err) {
    logger.error("❌ create report error:", err);
    res.status(500).json({ success: false, error: "report_create_failed" });
  }
});

// Rapor durumunu güncelle (admin only)
router.put("/:id", auth, requirePermission("reports:manage"), async (req, res) => {
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

    if (!updated) return sendError(res, 404, "Rapor bulunamadı");

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
    logger.error("❌ report update error:", err);
    res.status(500).json({ success: false, error: "report_update_failed" });
  }
});

// Rapor sil (admin only)
router.delete("/:id", auth, requirePermission("reports:manage"), async (req, res) => {
  try {
    const id = req.params.id;
    await Report.deleteOne({ _id: id });

    res.json({ success: true, message: "Silindi" });
  } catch (err) {
    logger.error("❌ report delete error:", err);
    res.status(500).json({ success: false, error: "report_delete_failed" });
  }
});

module.exports = router;
