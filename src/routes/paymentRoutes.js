const express = require("express");
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const paymentController = require("../controllers/paymentController");

const router = express.Router();

router.get("/catalog", paymentController.getCatalog);
router.post("/intents", auth, paymentController.createIntent);
router.get("/me", auth, paymentController.getMyPayments);

router.get("/mock-checkout", paymentController.mockCheckout);
router.get("/mock-complete", paymentController.mockComplete);
router.post("/webhook", paymentController.webhook);

router.get("/:orderId", auth, paymentController.getMyPaymentByOrderId);
router.post("/:orderId/refund", auth, requirePermission("finance:view"), paymentController.refundPayment);

module.exports = router;
