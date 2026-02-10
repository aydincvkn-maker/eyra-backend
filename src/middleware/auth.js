// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const User = require("../models/User");

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
      return res.status(401).json({ message: "Token bulunamadı" });
    }
    
    // 2. Token'ı doğrula
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // 3. Kullanıcıyı bul
    const user = await User.findById(decoded.id).select("-password");
    
    if (!user) {
      return res.status(401).json({ message: "Kullanıcı bulunamadı" });
    }

    if (user.isBanned || user.isActive === false || user.isFrozen === true) {
      // Admin ve super_admin hesapları ban kontrolünden muaf tut
      const isAdminRole = user.role === "admin" || user.role === "super_admin";
      if (!isAdminRole) {
        return res.status(403).json({ message: "Hesap erişimi kısıtlı" });
      }
      // Admin ise otomatik olarak ban/freeze'i kaldır
      await User.findByIdAndUpdate(user._id, {
        $set: { isBanned: false, isFrozen: false, isActive: true }
      });
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
      return res.status(401).json({ message: "Geçersiz token" });
    }
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "Token süresi dolmuş" });
    }
    
    return res.status(500).json({ message: "Sunucu hatası" });
  }
}

module.exports = auth;