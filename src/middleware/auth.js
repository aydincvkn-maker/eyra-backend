// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const User = require("../models/User");
const { sendError } = require("../utils/response");

async function auth(req, res, next) {
  try {
    const parseCookie = (header = "") => {
      return header.split(";").reduce((acc, part) => {
        const [key, ...value] = part.trim().split("=");
        if (!key) return acc;
        acc[key] = decodeURIComponent(value.join("="));
        return acc;
      }, {});
    };

    // 1. Header'dan token'ı al (Bearer) veya httpOnly cookie
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    if (!token && req.headers.cookie) {
      const cookies = parseCookie(req.headers.cookie);
      token = cookies.auth_token || cookies.access_token || null;
    }

    if (!token) {
      return sendError(res, 401, "Token bulunamadı");
    }
    
    // 2. Token'ı doğrula
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // 3. Kullanıcıyı bul
    const user = await User.findById(decoded.id).select("-password");
    
    if (!user) {
      return sendError(res, 401, "Kullanıcı bulunamadı");
    }

    if (user.isBanned || user.isActive === false || user.isFrozen === true) {
      return sendError(res, 403, "Hesap erişimi kısıtlı");
    }
    
    // 4. req.user'a ekle
    req.user = {
      id: user._id,
      role: user.role,
      email: user.email,
      username: user.username,
      permissions: user.permissions || []
    };
    
    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    
    if (err.name === 'JsonWebTokenError') {
      return sendError(res, 401, "Geçersiz token");
    }
    
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 401, "Token süresi dolmuş");
    }
    
    return sendError(res, 500, "Sunucu hatası");
  }
}

module.exports = auth;