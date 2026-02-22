const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");

// Login
router.post("/login", authLimiter, authController.login);

// Register
router.post("/register", authLimiter, authController.register);

// Google Login (ESKİ - basit)
router.post("/google-login", authLimiter, authController.googleLogin);

// ✅ YENİ: Google Login (Token ile doğrulama)
router.post("/google-login-token", authLimiter, authController.googleLoginWithToken);

// ✅ YENİ: Apple Login
router.post("/apple-login", authLimiter, authController.appleLogin);

// Guest Login
router.post("/guest-login", authLimiter, authController.guestLogin);

// Logout
router.post("/logout", authMiddleware, authController.logout);

// Me (korumalı route)
router.get("/me", authMiddleware, authController.me);

// ✅ Token Refresh - Generate new token
router.post("/refresh-token", authMiddleware, authController.refreshToken);

module.exports = router;