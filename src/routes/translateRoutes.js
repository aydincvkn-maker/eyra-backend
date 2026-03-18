// src/routes/translateRoutes.js
// General-purpose translation proxy — used by Flutter web clients
// (browsers cannot call Google Translate API directly due to CORS)

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const translationService = require("../services/translationService");

// POST /api/translate/text
// Body: { text, targetLang, sourceLang? }
router.post("/text", auth, async (req, res) => {
  try {
    const { text, targetLang, sourceLang } = req.body;

    if (!text || !targetLang) {
      return res
        .status(400)
        .json({ ok: false, error: "text and targetLang required" });
    }

    if (text.length > 5000) {
      return res
        .status(400)
        .json({ ok: false, error: "text too long (max 5000 chars)" });
    }

    const result = await translationService.translateText(
      text,
      targetLang,
      sourceLang || "auto",
    );

    res.json({
      ok: true,
      translatedText: result.translatedText,
      detectedLanguage: result.detectedLanguage,
    });
  } catch (err) {
    console.error("translate/text error:", err.message);
    res.status(500).json({ ok: false, error: "translation_failed" });
  }
});

module.exports = router;
