// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const User = require("../models/User");

async function auth(req, res, next) {
  try {
    // 1. Header'dan token'ı al
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: "Token bulunamadı" });
    }
    
    const token = authHeader.split(' ')[1];
    
    // 2. Token'ı doğrula
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // 3. Kullanıcıyı bul
    const user = await User.findById(decoded.id).select("-password");
    
    if (!user) {
      return res.status(401).json({ message: "Kullanıcı bulunamadı" });
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