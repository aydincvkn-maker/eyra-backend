const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/auth");

// Login
router.post("/login", authController.login);

// Register
router.post("/register", authController.register);

// Google Login (ESKİ - basit)
router.post("/google-login", authController.googleLogin);

// ✅ YENİ: Google Login (Token ile doğrulama)
router.post("/google-login-token", authController.googleLoginWithToken);

// ✅ YENİ: Apple Login
router.post("/apple-login", authController.appleLogin);

// Guest Login
router.post("/guest-login", authController.guestLogin);

// Logout
router.post("/logout", authMiddleware, authController.logout);

// Me (korumalı route)
router.get("/me", authMiddleware, authController.me);

// ✅ Token Refresh - Generate new token
router.post("/refresh-token", authMiddleware, authController.refreshToken);

module.exports = router;