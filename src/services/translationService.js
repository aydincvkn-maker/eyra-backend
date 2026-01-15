// src/services/translationService.js
// Anlık mesaj çeviri servisi - Google Translate API ile

const axios = require('axios');

// Google Translate ücretsiz endpoint (unofficial - production için resmi API kullanın)
const TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// Desteklenen diller
const SUPPORTED_LANGUAGES = {
  'tr': 'Türkçe',
  'en': 'English',
  'ar': 'العربية',
  'ru': 'Русский',
  'de': 'Deutsch',
  'fr': 'Français',
  'es': 'Español',
  'pt': 'Português',
  'it': 'Italiano',
  'ja': '日本語',
  'ko': '한국어',
  'zh': '中文',
  'hi': 'हिन्दी',
  'fa': 'فارسی',
  'az': 'Azərbaycan',
  'uk': 'Українська'
};

// Cache: son çeviriler için memory cache (performans için)
const translationCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 saat
const MAX_CACHE_SIZE = 1000;

/**
 * Cache key oluştur
 */
const getCacheKey = (text, sourceLang, targetLang) => {
  return `${sourceLang}:${targetLang}:${text.substring(0, 100)}`;
};

/**
 * Cache'i temizle (eski girdileri sil)
 */
const cleanCache = () => {
  if (translationCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(translationCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, Math.floor(MAX_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => translationCache.delete(key));
  }
};

/**
 * Tek bir metni çevir
 * @param {string} text - Çevrilecek metin
 * @param {string} targetLang - Hedef dil kodu (ör: 'en', 'tr')
 * @param {string} sourceLang - Kaynak dil kodu (opsiyonel, 'auto' için boş bırak)
 * @returns {Promise<{translatedText: string, detectedLanguage: string}>}
 */
exports.translateText = async (text, targetLang, sourceLang = 'auto') => {
  if (!text || text.trim().length === 0) {
    return { translatedText: text, detectedLanguage: sourceLang };
  }

  // Hedef dil kaynak dil ile aynıysa çevirme
  if (sourceLang !== 'auto' && sourceLang === targetLang) {
    return { translatedText: text, detectedLanguage: sourceLang };
  }

  // Cache kontrol
  const cacheKey = getCacheKey(text, sourceLang, targetLang);
  const cached = translationCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const response = await axios.get(TRANSLATE_ENDPOINT, {
      params: {
        client: 'gtx',
        sl: sourceLang,
        tl: targetLang,
        dt: 't',
        q: text
      },
      timeout: 5000
    });

    // Response formatı: [[["çeviri","orijinal",null,null,1]],null,"en"]
    const translatedText = response.data[0]
      ?.map(item => item[0])
      ?.join('') || text;
    
    const detectedLanguage = response.data[2] || sourceLang;

    const result = { translatedText, detectedLanguage };

    // Cache'e kaydet
    cleanCache();
    translationCache.set(cacheKey, { result, timestamp: Date.now() });

    return result;
  } catch (err) {
    console.error('❌ Translation error:', err.message);
    // Hata durumunda orijinal metni döndür
    return { translatedText: text, detectedLanguage: sourceLang, error: err.message };
  }
};

/**
 * Birden fazla metni toplu çevir
 * @param {string[]} texts - Çevrilecek metinler
 * @param {string} targetLang - Hedef dil
 * @param {string} sourceLang - Kaynak dil
 * @returns {Promise<Array<{original: string, translated: string, detectedLanguage: string}>>}
 */
exports.translateBatch = async (texts, targetLang, sourceLang = 'auto') => {
  const results = await Promise.all(
    texts.map(async (text) => {
      const { translatedText, detectedLanguage } = await exports.translateText(text, targetLang, sourceLang);
      return {
        original: text,
        translated: translatedText,
        detectedLanguage
      };
    })
  );
  return results;
};

/**
 * Chat mesajını çevir (özel format)
 * @param {Object} message - Chat mesajı objesi
 * @param {string} targetLang - Hedef dil
 * @param {string} viewerLang - İzleyicinin dili (opsiyonel)
 * @returns {Promise<Object>} - Çevrilmiş mesaj
 */
exports.translateChatMessage = async (message, targetLang, viewerLang = null) => {
  if (!message || !message.content) {
    return message;
  }

  // Gift mesajları çevirilmez
  if (message.type === 'gift') {
    return message;
  }

  const { translatedText, detectedLanguage } = await exports.translateText(
    message.content,
    targetLang,
    'auto'
  );

  return {
    ...message,
    originalContent: message.content,
    content: translatedText,
    translatedTo: targetLang,
    detectedLanguage,
    isTranslated: translatedText !== message.content
  };
};

/**
 * Kullanıcının tercih ettiği dili algıla
 * (Header veya user settings'den)
 */
exports.detectUserLanguage = (req) => {
  // 1. Query param kontrol
  if (req.query?.lang && SUPPORTED_LANGUAGES[req.query.lang]) {
    return req.query.lang;
  }

  // 2. Header kontrol
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage) {
    const primaryLang = acceptLanguage.split(',')[0].split('-')[0].toLowerCase();
    if (SUPPORTED_LANGUAGES[primaryLang]) {
      return primaryLang;
    }
  }

  // 3. Default Türkçe
  return 'tr';
};

/**
 * Desteklenen dilleri getir
 */
exports.getSupportedLanguages = () => {
  return Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => ({
    code,
    name
  }));
};

/**
 * Dil kodu geçerli mi kontrol et
 */
exports.isValidLanguage = (langCode) => {
  return !!SUPPORTED_LANGUAGES[langCode];
};

/**
 * Cache istatistiklerini al
 */
exports.getCacheStats = () => {
  return {
    size: translationCache.size,
    maxSize: MAX_CACHE_SIZE
  };
};
