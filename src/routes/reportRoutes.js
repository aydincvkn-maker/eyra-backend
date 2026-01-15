const express = require("express");
const router = express.Router();

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

// Tüm raporları getir
router.get("/", (req, res) => {
  res.json(reports);
});

// Rapor durumunu güncelle
router.put("/:id", (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  const r = reports.find((x) => x._id === id);
  if (!r) return res.status(404).json({ message: "Rapor bulunamadı" });

  r.status = status;
  res.json(r);
});

// Rapor sil
router.delete("/:id", (req, res) => {
  const id = req.params.id;
  reports = reports.filter((x) => x._id !== id);

  res.json({ message: "Silindi" });
});

module.exports = router;
