// src/config/db.js
const mongoose = require("mongoose");
const { MONGO_URI } = require("./env");

function normalizeMongoUri(uri) {
  if (!uri || typeof uri !== "string") return uri;

  if (!uri.startsWith("mongodb+srv://")) {
    return uri;
  }

  try {
    const parsed = new URL(uri);
    if (!parsed.username || parsed.searchParams.has("authSource")) {
      return uri;
    }

    parsed.searchParams.set("authSource", "admin");
    return parsed.toString();
  } catch (_) {
    return uri;
  }
}

async function connectDB() {
  try {
    await mongoose.connect(normalizeMongoUri(MONGO_URI), {
      serverSelectionTimeoutMS: 15000,
    });
    console.log("✅ MongoDB bağlantısı başarılı");
  } catch (err) {
    console.error("❌ MongoDB bağlantı hatası:", err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
