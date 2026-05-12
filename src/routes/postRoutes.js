// src/routes/postRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const auth = require("../middleware/auth");
const postController = require("../controllers/postController");

const allowedImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/x-ms-bmp",
]);

// Multer konfigürasyonu - post fotoğraf yükleme
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const mimeType = String(file.mimetype || "").toLowerCase();
    if (allowedImageMimeTypes.has(mimeType)) {
      return cb(null, true);
    }

    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowed = new Set([
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".heic",
      ".heif",
      ".bmp",
    ]);
    if (allowed.has(ext)) {
      return cb(null, true);
    }
    const uploadError = new Error("Sadece resim dosyaları yüklenebilir");
    uploadError.statusCode = 400;
    return cb(uploadError, false);
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
