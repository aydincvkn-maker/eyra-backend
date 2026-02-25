// src/utils/response.js
// Unified HTTP response helpers for consistent API responses.
// Standard error shape:   { success: false, message: "...", error: "..." }
// Standard success shape: { success: true, ...data }

/**
 * Send a standardized error response.
 * Includes both `message` and `error` keys for backward compatibility.
 *
 * @param {import('express').Response} res
 * @param {number} statusCode  HTTP status (4xx / 5xx)
 * @param {string} message     Human-readable error description
 * @param {object} [extra]     Optional extra fields merged into response
 */
function sendError(res, statusCode, message, extra = {}) {
  return res.status(statusCode).json({
    success: false,
    message,
    error: message,
    ...extra,
  });
}

/**
 * Send a standardized success response.
 *
 * @param {import('express').Response} res
 * @param {object} [data]       Data merged into response body
 * @param {number} [statusCode] HTTP status (default 200)
 */
function sendSuccess(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    ...data,
  });
}

module.exports = { sendError, sendSuccess };
