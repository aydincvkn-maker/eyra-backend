// src/middleware/validate.js
// Centralized input validation middleware using express-validator

const { body, param, query, validationResult } = require("express-validator");

/**
 * Middleware that checks validation results and returns errors if any
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }
  next();
};

// ========================================
// AUTH VALIDATORS
// ========================================

const validateRegister = [
  body("email")
    .isEmail()
    .withMessage("Valid email is required")
    .normalizeEmail()
    .isLength({ max: 255 })
    .withMessage("Email too long"),
  body("password")
    .isLength({ min: 6, max: 128 })
    .withMessage("Password must be 6-128 characters"),
  body("username")
    .trim()
    .isLength({ min: 2, max: 30 })
    .withMessage("Username must be 2-30 characters")
    .matches(/^[a-zA-Z0-9_.\-\s]+$/)
    .withMessage("Username contains invalid characters"),
  body("gender")
    .optional()
    .isIn(["male", "female"])
    .withMessage("Gender must be male or female"),
  body("age")
    .optional()
    .isInt({ min: 18, max: 120 })
    .withMessage("Age must be between 18-120"),
  handleValidationErrors,
];

const validateLogin = [
  body("email")
    .isEmail()
    .withMessage("Valid email is required")
    .normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required"),
  handleValidationErrors,
];

// ========================================
// CHAT VALIDATORS
// ========================================

const validateSendMessage = [
  body("to").isMongoId().withMessage("Valid recipient ID required"),
  body("text")
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 5000 })
    .withMessage("Text must be at most 5000 characters"),
  body("content")
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 5000 })
    .withMessage("Content must be at most 5000 characters"),
  body().custom((_, { req }) => {
    const text = String(req.body?.text ?? "").trim();
    const content = String(req.body?.content ?? "").trim();
    const mediaUrl = String(req.body?.mediaUrl ?? "").trim();

    if (!text && !content && !mediaUrl) {
      throw new Error("Message must include text/content or mediaUrl");
    }

    const resolved = text || content;
    if (resolved) {
      req.body.text = resolved;
      req.body.content = resolved;
    }

    return true;
  }),
  body("type")
    .optional()
    .isIn([
      "text",
      "image",
      "video",
      "audio",
      "gif",
      "system",
      "gift",
      "call_ended",
      "voice",
      "file",
    ])
    .withMessage("Invalid message type"),
  handleValidationErrors,
];

// ========================================
// PAYMENT VALIDATORS
// ========================================

const validateCreatePaymentIntent = [
  body("productCode")
    .trim()
    .notEmpty()
    .withMessage("Product code is required")
    .isLength({ max: 50 })
    .withMessage("Product code too long"),
  body("method")
    .optional()
    .isIn(["card", "crypto"])
    .withMessage("Invalid payment method"),
  body("idempotencyKey")
    .optional()
    .isString()
    .isLength({ max: 100 })
    .withMessage("Idempotency key too long"),
  body("platform")
    .optional()
    .isIn(["android", "ios", "web", "unknown"])
    .withMessage("Invalid platform"),
  body("channel")
    .optional()
    .isIn(["app", "web"])
    .withMessage("Invalid channel"),
  handleValidationErrors,
];

const validateIapPurchase = [
  body("productId")
    .trim()
    .notEmpty()
    .withMessage("Product ID is required")
    .isLength({ max: 100 })
    .withMessage("Product ID too long"),
  body("transactionId")
    .trim()
    .notEmpty()
    .withMessage("Transaction ID is required")
    .isLength({ max: 200 })
    .withMessage("Transaction ID too long"),
  body("platform")
    .optional()
    .isIn(["android", "ios"])
    .withMessage("Platform must be android or ios"),
  handleValidationErrors,
];

// ========================================
// USER VALIDATORS
// ========================================

const validateUpdateProfile = [
  body("username")
    .optional()
    .trim()
    .isLength({ min: 2, max: 30 })
    .withMessage("Username must be 2-30 characters")
    .matches(/^[a-zA-Z0-9_.\-\s]+$/)
    .withMessage("Username contains invalid characters"),
  body("bio")
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage("Bio must be max 500 characters"),
  body("age")
    .optional()
    .isInt({ min: 18, max: 120 })
    .withMessage("Age must be between 18-120"),
  body("gender")
    .optional()
    .isIn(["male", "female"])
    .withMessage("Gender must be male or female"),
  handleValidationErrors,
];

// ========================================
// GIFT VALIDATORS
// ========================================

const validateSendGift = [
  body("giftId").isMongoId().withMessage("Valid gift ID required"),
  body("recipientId").isMongoId().withMessage("Valid receiver ID required"),
  body("streamId")
    .optional()
    .isMongoId()
    .withMessage("Valid stream ID required"),
  handleValidationErrors,
];

// ========================================
// LIVE VALIDATORS
// ========================================

const validateStartLive = [
  body("title")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Title must be max 100 characters"),
  body("category")
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Category must be max 50 characters"),
  handleValidationErrors,
];

// ========================================
// REPORT VALIDATORS
// ========================================

const validateReport = [
  body("targetId")
    .optional()
    .isMongoId()
    .withMessage("Valid target user ID required"),
  body("streamId")
    .optional()
    .isMongoId()
    .withMessage("Valid stream ID required"),
  body("reason")
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage("Reason must be 3-500 characters"),
  handleValidationErrors,
];

// ========================================
// COMMON VALIDATORS
// ========================================

const validateMongoId = [
  param("id").isMongoId().withMessage("Valid ID required"),
  handleValidationErrors,
];

const validatePagination = [
  query("page")
    .optional()
    .isInt({ min: 1, max: 1000 })
    .withMessage("Page must be 1-1000"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be 1-100"),
  handleValidationErrors,
];

// ========================================
// SANITIZATION HELPERS
// ========================================

/**
 * Middleware to strip MongoDB operators from request body
 * Prevents NoSQL injection via $gt, $ne, $where, etc.
 */
const sanitizeMongoQuery = (req, res, next) => {
  const sanitize = (obj) => {
    if (typeof obj !== "object" || obj === null) return obj;
    for (const key of Object.keys(obj)) {
      if (key.startsWith("$")) {
        delete obj[key];
      } else if (typeof obj[key] === "object") {
        obj[key] = sanitize(obj[key]);
      }
    }
    return obj;
  };

  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);
  next();
};

module.exports = {
  handleValidationErrors,
  validateRegister,
  validateLogin,
  validateSendMessage,
  validateCreatePaymentIntent,
  validateIapPurchase,
  validateUpdateProfile,
  validateSendGift,
  validateStartLive,
  validateReport,
  validateMongoId,
  validatePagination,
  sanitizeMongoQuery,
};
