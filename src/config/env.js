// src/config/env.js
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const NODE_ENV = process.env.NODE_ENV || "development";

const isEmpty = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
};

const required = (key, fallback) => {
  const raw = process.env[key];
  if (!isEmpty(raw)) return raw;

  const hasFallback = fallback !== undefined;
  if (!hasFallback) {
    if (NODE_ENV === "production") {
      throw new Error(`[ENV] ${key} tanımlı değil`);
    }
    console.warn(`[ENV] ${key} tanımlı değil`);
    return undefined;
  }

  if (NODE_ENV === "production") {
    console.warn(
      `[ENV] ${key} tanımlı değil, fallback kullanılıyor: ${fallback}`,
    );
    return fallback;
  }

  console.warn(
    `[ENV] ${key} tanımlı değil, fallback kullanılıyor: ${fallback}`,
  );
  return fallback;
};

module.exports = {
  NODE_ENV,
  PORT: Number(required("PORT", 5000)),
  MONGO_URI: required("MONGO_URI", "mongodb://127.0.0.1:27017/eyra"),
  JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    if (!isEmpty(secret)) return secret;

    if (NODE_ENV === "production") {
      throw new Error("[ENV] JWT_SECRET tanımlı değil (production)");
    }

    const devFallback = "dev_only_change_this_secret";
    console.warn(
      "[ENV] JWT_SECRET tanımlı değil, development fallback kullanılıyor",
    );
    return devFallback;
  })(),
  CLIENT_ORIGIN: required("CLIENT_ORIGIN", "http://localhost:3000"),
  MOBILE_ORIGIN: required("MOBILE_ORIGIN", ""),
  JWT_EXPIRES_IN: required("JWT_EXPIRES_IN", "30d"),

  // 🔥 LIVEKIT Değerleri - Development'ta fallback, production'da mutlaka eklenmeli
  LIVEKIT_URL: required("LIVEKIT_URL", "wss://livekit.example.com"),
  LIVEKIT_API_KEY: required("LIVEKIT_API_KEY", ""),
  LIVEKIT_API_SECRET: required("LIVEKIT_API_SECRET", ""),

  PAYMENT_PROVIDER: (() => {
    const val = process.env.PAYMENT_PROVIDER;
    if (val && val.trim()) return val.trim();
    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] PAYMENT_PROVIDER production'da tanımlı olmalı! 'mock' kullanılamaz.",
      );
    }
    console.warn(
      "[ENV] PAYMENT_PROVIDER tanımlı değil, development fallback: mock",
    );
    return "mock";
  })(),
  PAYMENT_WEBHOOK_SECRET: (() => {
    const val = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!isEmpty(val)) return val;
    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] PAYMENT_WEBHOOK_SECRET production'da tanımlı olmalı!",
      );
    }
    console.warn(
      "[ENV] PAYMENT_WEBHOOK_SECRET tanımlı değil, dev fallback kullanılıyor",
    );
    return "dev_payment_webhook_secret";
  })(),
  PAYMENT_SUCCESS_URL: required(
    "PAYMENT_SUCCESS_URL",
    "eyra://payment/success",
  ),
  PAYMENT_CANCEL_URL: required("PAYMENT_CANCEL_URL", "eyra://payment/cancel"),

  STRIPE_SECRET_KEY: required("STRIPE_SECRET_KEY", ""),
  STRIPE_WEBHOOK_SECRET: required("STRIPE_WEBHOOK_SECRET", ""),

  // RevenueCat
  REVENUECAT_API_KEY: (() => {
    const val = process.env.REVENUECAT_API_KEY;
    return isEmpty(val) ? "" : val;
  })(),
  REVENUECAT_API_BASE_URL: required(
    "REVENUECAT_API_BASE_URL",
    "https://api.revenuecat.com/v1",
  ),

  // Backend URL (CDN, webhook vb. için)
  BACKEND_URL: required("BACKEND_URL", "http://localhost:5000"),

  // Finansal sabitler
  COIN_TO_USD_RATE: Number(required("COIN_TO_USD_RATE", "0.01")),
  MIN_WITHDRAWAL_COINS: Number(required("MIN_WITHDRAWAL_COINS", "5000")),
  MAX_WITHDRAWAL_COINS: Number(required("MAX_WITHDRAWAL_COINS", "500000")),
};
