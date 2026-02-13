const SystemSettings = require("../models/SystemSettings");

let cachedSettings = null;
let lastFetch = 0;
const CACHE_TTL = 30000; // 30 saniye cache

const getSettings = async () => {
  const now = Date.now();
  if (cachedSettings && now - lastFetch < CACHE_TTL) {
    return cachedSettings;
  }
  try {
    cachedSettings = await SystemSettings.findOne().lean();
    lastFetch = now;
  } catch (_) {}
  return cachedSettings;
};

// Bakım modu middleware
const maintenanceMiddleware = async (req, res, next) => {
  try {
    // Health endpoint'i her zaman çalışmalı
    if (req.path === "/api/health" || req.path === "/health") {
      return next();
    }

    // Auth endpoint'leri her zaman çalışmalı (admin giriş yapabilmeli)
    if (req.path.startsWith("/api/auth")) {
      return next();
    }

    // Admin endpoint'leri her zaman çalışmalı
    if (req.path.startsWith("/api/admin") || req.path.startsWith("/api/settings")) {
      return next();
    }

    const settings = await getSettings();
    if (settings?.maintenanceMode) {
      // Admin olarak giriş yapmış kullanıcılar bakım modunda da erişebilir
      if (req.user && req.user.role === "admin") {
        return next();
      }

      return res.status(503).json({
        success: false,
        error: "Sistem bakımda, lütfen daha sonra tekrar deneyin.",
        maintenance: true,
      });
    }

    next();
  } catch (err) {
    // Hata durumunda bakım modunu devre dışı bırak (güvenli taraf)
    next();
  }
};

// Cache'i temizle (ayar değiştiğinde çağrılacak)
maintenanceMiddleware.clearCache = () => {
  cachedSettings = null;
  lastFetch = 0;
};

module.exports = maintenanceMiddleware;
