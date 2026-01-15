// src/utils/token.js
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");

function signToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  signToken,
  verifyToken,
};
