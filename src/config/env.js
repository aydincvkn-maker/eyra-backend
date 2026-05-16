// src/config/env.js
const crypto = require("crypto");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const NODE_ENV = process.env.NODE_ENV || "development";

const isEmpty = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
};

const devJwtFallback = crypto.randomBytes(32).toString("hex");

const ensureMinSecretLength = (key, value, minLength) => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(
      `[ENV] ${key} tanımlı değil. Render kullanıyorsanız Dashboard > Environment içinde ${key} ekleyin.`,
    );
  }

  if (normalized.length < minLength) {
    throw new Error(
      `[ENV] ${key} en az ${minLength} karakter olmalı (mevcut: ${normalized.length}). Render kullanıyorsanız Dashboard > Environment içinde ${key} değerini 32+ karakter olacak şekilde güncelleyin.`,
    );
  }

  return normalized;
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
  MONGO_URI: (() => {
    const uri = process.env.MONGO_URI;
    if (!isEmpty(uri)) return uri;

    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] MONGO_URI tanımlı değil (production). Render kullanıyorsanız Dashboard > Environment içinde MONGO_URI ekleyin.",
      );
    }

    console.warn(
      "[ENV] MONGO_URI tanımlı değil, fallback kullanılıyor: mongodb://127.0.0.1:27017/eyra",
    );
    return "mongodb://127.0.0.1:27017/eyra";
  })(),
  JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    if (!isEmpty(secret)) return secret;

    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] JWT_SECRET tanımlı değil (production). Render kullanıyorsanız Dashboard > Environment içinde JWT_SECRET ekleyin.",
      );
    }

    console.warn(
      "[ENV] JWT_SECRET tanımlı değil, process-ephemeral development fallback kullanılıyor",
    );
    return devJwtFallback;
  })(),
  CLIENT_ORIGIN: required("CLIENT_ORIGIN", "http://localhost:3000"),
  MOBILE_ORIGIN: required("MOBILE_ORIGIN", ""),
  JWT_EXPIRES_IN: required("JWT_EXPIRES_IN", "7d"),

  // 🔥 LIVEKIT Değerleri - Development'ta fallback, production'da mutlaka eklenmeli
  LIVEKIT_URL: (() => {
    const val = process.env.LIVEKIT_URL;
    if (!isEmpty(val)) return val;
    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] LIVEKIT_URL production'da tanımlı olmalı! Render Dashboard > Environment içinde ekleyin.",
      );
    }
    console.warn("[ENV] LIVEKIT_URL tanımlı değil, dev fallback kullanılıyor");
    return "wss://livekit.example.com";
  })(),
  LIVEKIT_API_KEY: (() => {
    const val = process.env.LIVEKIT_API_KEY;
    if (!isEmpty(val)) return val;
    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] LIVEKIT_API_KEY production'da tanımlı olmalı! Render Dashboard > Environment içinde ekleyin.",
      );
    }
    console.warn("[ENV] LIVEKIT_API_KEY tanımlı değil");
    return "";
  })(),
  LIVEKIT_API_SECRET: (() => {
    const val = process.env.LIVEKIT_API_SECRET;
    if (!isEmpty(val)) return val;
    if (NODE_ENV === "production") {
      throw new Error(
        "[ENV] LIVEKIT_API_SECRET production'da tanımlı olmalı! Render Dashboard > Environment içinde ekleyin.",
      );
    }
    console.warn("[ENV] LIVEKIT_API_SECRET tanımlı değil");
    return "";
  })(),

  PAYMENT_PROVIDER: (() => {
    const val = String(process.env.PAYMENT_PROVIDER || "")
      .trim()
      .toLowerCase();

    if (!val) {
      if (NODE_ENV === "production") {
        throw new Error(
          "[ENV] PAYMENT_PROVIDER production'da tanımlı olmalı! 'mock' kullanılamaz.",
        );
      }
      console.warn(
        "[ENV] PAYMENT_PROVIDER tanımlı değil, development fallback: mock",
      );
      return "mock";
    }

    if (!["mock", "stripe"].includes(val)) {
      throw new Error(
        "[ENV] PAYMENT_PROVIDER geçersiz. Desteklenen değerler: mock, stripe",
      );
    }

    if (NODE_ENV === "production" && val !== "stripe") {
      throw new Error(
        "[ENV] PAYMENT_PROVIDER production'da 'stripe' olmalı. 'mock' kullanılamaz.",
      );
    }

    return val;
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
  PAYMENT_WEB_SUCCESS_URL: required("PAYMENT_WEB_SUCCESS_URL", ""),
  PAYMENT_WEB_CANCEL_URL: required("PAYMENT_WEB_CANCEL_URL", ""),

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

if (NODE_ENV === "production") {
  ensureMinSecretLength("JWT_SECRET", module.exports.JWT_SECRET, 32);
  ensureMinSecretLength(
    "PAYMENT_WEBHOOK_SECRET",
    module.exports.PAYMENT_WEBHOOK_SECRET,
    24,
  );

  if (!String(module.exports.CLIENT_ORIGIN || "").trim()) {
    throw new Error("[ENV] CLIENT_ORIGIN production'da boş bırakılamaz");
  }

  const disallowedOrigins = [
    module.exports.CLIENT_ORIGIN,
    module.exports.MOBILE_ORIGIN,
  ]
    .join(",")
    .split(",")
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => value === "*" || /^http:\/\//i.test(value));

  if (disallowedOrigins.length > 0) {
    throw new Error(
      `[ENV] Production origin ayarı güvensiz: ${disallowedOrigins.join(", ")}`,
    );
  }
}
