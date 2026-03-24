const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");
const { validateLogin, validateRegister } = require("../middleware/validate");

// Login
router.post("/login", authLimiter, validateLogin, authController.login);

// Panel login
router.post(
  "/panel-login",
  authLimiter,
  validateLogin,
  authController.panelLogin,
);

// Register
router.post(
  "/register",
  authLimiter,
  validateRegister,
  authController.register,
);

// Google Login (DEPRECATED - token doğrulaması yok, 403 döndürür)
router.post("/google-login", authLimiter, authController.googleLogin);

// ✅ Google Login (Token ile doğrulama - TEK GÜVENLİ YOL)
router.post(
  "/google-login-token",
  authLimiter,
  authController.googleLoginWithToken,
);

// ✅ YENİ: Apple Login
router.post("/apple-login", authLimiter, authController.appleLogin);

// Guest Login
router.post("/guest-login", authLimiter, authController.guestLogin);

// ✅ Phone Login (Firebase Phone Auth ile doğrulanmış)
router.post("/phone-login", authLimiter, authController.phoneLogin);

// Logout
router.post("/logout", authMiddleware, authController.logout);

// Me (korumalı route)
router.get("/me", authMiddleware, authController.me);

// ✅ Token Refresh - Generate new token
router.post("/refresh-token", authMiddleware, authController.refreshToken);

// ✅ Şifre Değiştir
router.put("/change-password", authMiddleware, authController.changePassword);

// ✅ Şifremi Unuttum (Firebase reset sonrası backend sync)
router.post("/forgot-password", authLimiter, authController.forgotPassword);

module.exports = router;
