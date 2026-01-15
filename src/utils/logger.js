// src/utils/logger.js
const morgan = require("morgan");

const morganLogger = morgan(":method :url :status - :response-time ms");

const logger = {
  info: (...args) => console.log("ℹ️ [INFO]", ...args),
  error: (...args) => console.error("❌ [ERROR]", ...args),
  warn: (...args) => console.warn("⚠️ [WARN]", ...args),
  debug: (...args) => console.log("🐛 [DEBUG]", ...args),
};

function logInfo(...args) {
  console.log("[INFO]", ...args);
}

function logError(...args) {
  console.error("[ERROR]", ...args);
}

module.exports = {
  logger,
  morganLogger,
  logInfo,
  logError,
};
