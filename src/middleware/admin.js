// src/middleware/admin.js
function admin(req, res, next) {
  if (!req.user || !["admin", "super_admin"].includes(req.user.role)) {
    return res.status(403).json({ message: "Admin yetkisi gerekli" });
  }
  next();
}

module.exports = admin;
