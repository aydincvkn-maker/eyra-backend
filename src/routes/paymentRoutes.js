const express = require("express");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const paymentController = require("../controllers/paymentController");

const router = express.Router();

router.get("/catalog", paymentController.getCatalog);
router.post("/intents", auth, paymentController.createIntent);
router.get("/me", auth, paymentController.getMyPayments);
router.get("/:orderId", auth, paymentController.getMyPaymentByOrderId);

router.post("/webhook", paymentController.webhook);

router.post("/:orderId/refund", auth, requirePermission("finance:view"), paymentController.refundPayment);

router.get("/mock-checkout", paymentController.mockCheckout);
router.get("/mock-complete", paymentController.mockComplete);

module.exports = router;
