// src/routes/postRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const auth = require("../middleware/auth");
const postController = require("../controllers/postController");

// Multer konfigürasyonu - post fotoğraf yükleme
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowed = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
    if (allowed.has(ext)) {
      return cb(null, true);
    }
    return cb(new Error("Sadece resim dosyaları yüklenebilir"), false);
  },
});

// Feed
router.get("/", auth, postController.getFeed);
router.get("/user/:userId", auth, postController.getUserPosts);

// CRUD
router.post("/", auth, upload.single("image"), postController.createPost);
router.delete("/:postId", auth, postController.deletePost);

// Etkileşim
router.post("/:postId/like", auth, postController.toggleLike);

module.exports = router;
