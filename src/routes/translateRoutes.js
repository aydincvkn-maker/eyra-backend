// src/routes/translateRoutes.js
// General-purpose translation proxy — used by Flutter web clients
// (browsers cannot call Google Translate API directly due to CORS)

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const translationService = require("../services/translationService");
const { logger } = require("../utils/logger");

const MAX_BATCH_ITEMS = 1000;
const MAX_TEXT_LENGTH = 5000;

function sanitizeLanguage(lang) {
  return String(lang || "auto").trim().toLowerCase();
}

function sanitizeText(text) {
  return String(text || "");
}

function validateTargetLanguage(targetLang) {
  const normalized = sanitizeLanguage(targetLang);
  return normalized && translationService.isValidLanguage(normalized);
}

function validateSourceLanguage(sourceLang) {
  const normalized = sanitizeLanguage(sourceLang);
  return normalized === "auto" || translationService.isValidLanguage(normalized);
}

router.get("/languages", (_req, res) => {
  res.json({
    ok: true,
    languages: translationService.getSupportedLanguages(),
  });
});

router.post("/batch", async (req, res) => {
  try {
    const texts = Array.isArray(req.body?.texts) ? req.body.texts.map(sanitizeText) : [];
    const targetLang = sanitizeLanguage(req.body?.targetLang);
    const sourceLang = sanitizeLanguage(req.body?.sourceLang);

    if (texts.length === 0 || !targetLang) {
      return res.status(400).json({
        ok: false,
        error: "texts and targetLang required",
      });
    }

    if (texts.length > MAX_BATCH_ITEMS) {
      return res.status(400).json({
        ok: false,
        error: `too many texts (max ${MAX_BATCH_ITEMS})`,
      });
    }

    if (!validateTargetLanguage(targetLang)) {
      return res.status(400).json({
        ok: false,
        error: "invalid targetLang",
      });
    }

    if (!validateSourceLanguage(sourceLang)) {
      return res.status(400).json({
        ok: false,
        error: "invalid sourceLang",
      });
    }

    const tooLong = texts.find((text) => text.length > MAX_TEXT_LENGTH);
    if (tooLong) {
      return res.status(400).json({
        ok: false,
        error: `text too long (max ${MAX_TEXT_LENGTH} chars)`,
      });
    }

    const translations = await translationService.translateBatch(
      texts,
      targetLang,
      sourceLang || "auto",
    );

    res.json({
      ok: true,
      translations,
    });
  } catch (err) {
    logger.error("translate/batch error:", err.message);
    res.status(500).json({ ok: false, error: "translation_failed" });
  }
});

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
    logger.error("translate/text error:", err.message);
    res.status(500).json({ ok: false, error: "translation_failed" });
  }
});

module.exports = router;
