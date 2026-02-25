// src/middleware/admin.js
const { sendError } = require("../utils/response");

function admin(req, res, next) {
  if (!req.user || !["admin", "super_admin"].includes(req.user.role)) {
    return sendError(res, 403, "Admin yetkisi gerekli");
  }
  next();
}

module.exports = admin;
