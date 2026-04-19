// src/utils/logger.js
// Structured logger — JSON in production, colored console in development.

const morgan = require("morgan");
const { NODE_ENV } = require("../config/env");

const IS_PROD = NODE_ENV === "production";

/** Format a log entry as JSON (production) or readable string (dev). */
function formatEntry(level, message, meta) {
  if (IS_PROD) {
    return JSON.stringify({
      level,
      msg: message,
      ...meta,
      ts: new Date().toISOString(),
    });
  }
  const prefix =
    { info: "ℹ️ ", error: "❌", warn: "⚠️ ", debug: "🐛" }[level] || "";
  const metaStr =
    meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return `${prefix} [${level.toUpperCase()}] ${message}${metaStr}`;
}

/** Normalize meta arg — accepts object, Error, string, or primitive. */
function normalizeMeta(meta) {
  if (meta instanceof Error) return { err: meta.message, stack: meta.stack };
  if (meta === null || meta === undefined) return {};
  if (typeof meta !== "object") return { detail: meta };
  return meta;
}

const logger = {
  info(message, meta = {}) {
    console.log(formatEntry("info", message, normalizeMeta(meta)));
  },
  error(message, meta = {}) {
    console.error(formatEntry("error", message, normalizeMeta(meta)));
  },
  warn(message, meta = {}) {
    console.warn(formatEntry("warn", message, normalizeMeta(meta)));
  },
  debug(message, meta = {}) {
    if (!IS_PROD) {
      console.log(formatEntry("debug", message, normalizeMeta(meta)));
    }
  },
};

// Morgan middleware — JSON tokens in production, dev colors otherwise
const morganLogger = IS_PROD
  ? morgan((tokens, req, res) =>
      JSON.stringify({
        level: "http",
        method: tokens.method(req, res),
        url: tokens.url(req, res),
        status: Number(tokens.status(req, res)),
        responseTime: Number(tokens["response-time"](req, res)),
        contentLength: tokens.res(req, res, "content-length"),
        ts: new Date().toISOString(),
      }),
    )
  : morgan(":method :url :status - :response-time ms");

// Backward-compatible named exports
function logInfo(...args) {
  logger.info(args.join(" "));
}

function logError(...args) {
  logger.error(args.join(" "));
}

module.exports = {
  logger,
  morganLogger,
  logInfo,
  logError,
};
