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
    throw new Error(`[ENV] ${key} tanımlı değil (production'da fallback kullanılmaz)`);
  }

  console.warn(`[ENV] ${key} tanımlı değil, fallback kullanılıyor: ${fallback}`);
  return fallback;
};

module.exports = {
  NODE_ENV,
  PORT: Number(required("PORT", 5000)),
  MONGO_URI: required("MONGO_URI", "mongodb://127.0.0.1:27017/eyra"),
  JWT_SECRET: required("JWT_SECRET", "super_secret_eyra_key"),
  CLIENT_ORIGIN: required("CLIENT_ORIGIN", "http://localhost:3000"),
  MOBILE_ORIGIN: required("MOBILE_ORIGIN", ""),

  // 🔥 LIVEKIT Değerleri - Development'ta fallback, production'da mutlaka eklenmeli
  LIVEKIT_URL: required("LIVEKIT_URL", "wss://livekit.example.com"),
  LIVEKIT_API_KEY: required("LIVEKIT_API_KEY", ""),
  LIVEKIT_API_SECRET: required("LIVEKIT_API_SECRET", ""),
};
