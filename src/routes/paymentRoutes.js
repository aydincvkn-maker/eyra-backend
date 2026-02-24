const express = require("express");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const paymentController = require("../controllers/paymentController");

const router = express.Router();

router.get("/catalog", paymentController.getCatalog);
router.post("/intents", auth, paymentController.createIntent);
router.post("/iap", auth, paymentController.iapPurchase);
router.get("/me", auth, paymentController.getMyPayments);

router.get("/admin/stats", auth, requirePermission("finance:view"), paymentController.adminGetStats);
router.get("/admin", auth, requirePermission("finance:view"), paymentController.adminGetPayments);

router.get("/mock-checkout", paymentController.mockCheckout);
router.get("/mock-complete", paymentController.mockComplete);
router.post("/webhook", paymentController.webhook);

router.get("/:orderId", auth, paymentController.getMyPaymentByOrderId);
router.post("/:orderId/confirm", auth, paymentController.confirmMyPaymentByOrderId);
router.post("/:orderId/refund", auth, requirePermission("finance:view"), paymentController.refundPayment);

module.exports = router;
