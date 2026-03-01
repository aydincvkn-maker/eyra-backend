const SystemSettings = require("../models/SystemSettings");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");

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

/**
 * JWT'den admin rolünü kontrol et (auth middleware çalışmadan önce)
 */
const isAdminFromToken = (req) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return false;
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.role === "admin";
  } catch {
    return false;
  }
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
      // JWT token'dan direkt kontrol et (req.user henüz set edilmemiş olabilir)
      if (req.user?.role === "admin" || isAdminFromToken(req)) {
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
