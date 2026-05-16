// src/routes/highlightRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { authenticate } = require("../middleware/auth");
const highlightController = require("../controllers/highlightController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB for videos
  fileFilter: (req, file, cb) => {
    const allowed = /^(image|video)\//;
    if (allowed.test(file.mimetype)) return cb(null, true);
    cb(new Error("Sadece resim ve video dosyaları yüklenebilir"));
  },
});

// GET /api/highlights/:userId  — public
router.get("/:userId", highlightController.getHighlights);

// POST /api/highlights  — authenticated
router.post("/", authenticate, upload.single("media"), highlightController.addHighlight);

// DELETE /api/highlights/:index  — authenticated
router.delete("/:index", authenticate, highlightController.deleteHighlight);

module.exports = router;
