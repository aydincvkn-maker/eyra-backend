const express = require("express");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const paymentController = require("../controllers/paymentController");
const {
  validateCreatePaymentIntent,
  validateIapPurchase,
  sanitizeMongoQuery,
} = require("../middleware/validate");
const { paymentLimiter } = require("../middleware/rateLimit");

const router = express.Router();
router.use(sanitizeMongoQuery);

router.get("/catalog", paymentController.getCatalog);
router.post(
  "/intents",
  auth,
  paymentLimiter,
  validateCreatePaymentIntent,
  paymentController.createIntent,
);
router.post(
  "/iap",
  auth,
  paymentLimiter,
  validateIapPurchase,
  paymentController.iapPurchase,
);
router.get("/me", auth, paymentController.getMyPayments);

router.get(
  "/admin/stats",
  auth,
  requirePermission("finance:view"),
  paymentController.adminGetStats,
);
router.get(
  "/admin",
  auth,
  requirePermission("finance:view"),
  paymentController.adminGetPayments,
);

// Mock routes - only available in non-production environments
if (process.env.NODE_ENV !== "production") {
  router.get("/mock-checkout", paymentController.mockCheckout);
  router.get("/mock-complete", paymentController.mockComplete);
}
router.post("/webhook", paymentController.webhook);

router.get("/:orderId", auth, paymentController.getMyPaymentByOrderId);
router.post(
  "/:orderId/confirm",
  auth,
  paymentController.confirmMyPaymentByOrderId,
);
router.post(
  "/:orderId/refund",
  auth,
  requirePermission("finance:manage"),
  paymentController.refundPayment,
);

module.exports = router;
