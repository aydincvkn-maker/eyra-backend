// src/controllers/highlightController.js
const User = require("../models/User");
const storageService = require("../services/storageService");
const { logger } = require("../utils/logger");

const MAX_HIGHLIGHTS = 20;
const MAX_VIDEO_DURATION_SECONDS = 30; // enforced client-side; noted for reference

// GET /api/highlights/:userId  — fetch highlights of any user
exports.getHighlights = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select("highlights").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }
    res.json({ success: true, highlights: user.highlights || [] });
  } catch (err) {
    logger.error("getHighlights error:", err);
    res.status(500).json({ success: false, message: "Highlights alınamadı" });
  }
};

// POST /api/highlights  — upload new highlight (photo or video)
exports.addHighlight = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: "Dosya gerekli" });
    }

    const user = await User.findById(userId).select("highlights").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    if ((user.highlights || []).length >= MAX_HIGHLIGHTS) {
      return res.status(400).json({
        success: false,
        message: `En fazla ${MAX_HIGHLIGHTS} highlight ekleyebilirsiniz`,
      });
    }

    const mimeType = file.mimetype || "";
    const isVideo = mimeType.startsWith("video/");
    const mediaType = isVideo ? "video" : "photo";

    // Upload to Cloudinary
    const uploadResult = await storageService.uploadHighlight(
      file.path || file.buffer,
      { resourceType: isVideo ? "video" : "image", folder: "highlights" }
    );

    const newHighlight = {
      url: uploadResult.url || uploadResult.secure_url,
      type: mediaType,
      thumbnailUrl: isVideo ? (uploadResult.thumbnailUrl || null) : null,
      createdAt: new Date(),
    };

    await User.findByIdAndUpdate(userId, {
      $push: { highlights: { $each: [newHighlight], $position: 0 } },
    });

    res.json({ success: true, highlight: newHighlight });
  } catch (err) {
    logger.error("addHighlight error:", err);
    res.status(500).json({ success: false, message: "Highlight yüklenemedi" });
  }
};

// DELETE /api/highlights/:index  — delete highlight by array index
exports.deleteHighlight = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const index = parseInt(req.params.index, 10);

    const user = await User.findById(userId).select("highlights");
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    if (isNaN(index) || index < 0 || index >= (user.highlights || []).length) {
      return res.status(400).json({ success: false, message: "Geçersiz index" });
    }

    const highlight = user.highlights[index];
    // Best-effort Cloudinary cleanup
    if (highlight?.url) {
      storageService.destroyByUrl &&
        storageService.destroyByUrl(highlight.url).catch(() => {});
    }

    user.highlights.splice(index, 1);
    await user.save();

    res.json({ success: true, message: "Highlight silindi" });
  } catch (err) {
    logger.error("deleteHighlight error:", err);
    res.status(500).json({ success: false, message: "Highlight silinemedi" });
  }
};
