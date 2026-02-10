const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

// Örnek dummy data — panel çalışsın diye
let reports = [
  {
    _id: "1",
    reporter: "testUser",
    target: "host123",
    reason: "Spam",
    status: "open",
    createdAt: new Date(),
  },
];

// Tüm raporları getir (admin only) + pagination
router.get("/", auth, admin, (req, res) => {
  const page = Math.max(parseInt(req.query.page || "1"), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "50"), 1), 200);
  const total = reports.length;
  const start = (page - 1) * limit;
  const items = reports.slice(start, start + limit);

  res.json({
    success: true,
    reports: items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// Rapor durumunu güncelle (admin only)
router.put("/:id", auth, admin, (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  const r = reports.find((x) => x._id === id);
  if (!r) return res.status(404).json({ message: "Rapor bulunamadı" });

  r.status = status;
  res.json({ success: true, report: r });
});

// Rapor sil (admin only)
router.delete("/:id", auth, admin, (req, res) => {
  const id = req.params.id;
  reports = reports.filter((x) => x._id !== id);

  res.json({ success: true, message: "Silindi" });
});

module.exports = router;
