const paymentService = require("../services/paymentService");
const Payment = require("../models/Payment");
const { PAYMENT_WEBHOOK_SECRET, PAYMENT_SUCCESS_URL, PAYMENT_CANCEL_URL } = require("../config/env");

exports.getCatalog = async (_req, res) => {
  try {
    const catalog = paymentService.getCatalog();
    res.json({ success: true, catalog });
  } catch (err) {
    console.error("getCatalog error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.createIntent = async (req, res) => {
  try {
    const { productCode, method, idempotencyKey } = req.body || {};

    const payment = await paymentService.createPaymentIntent({
      userId: req.user.id,
      productCode,
      method,
      idempotencyKey,
    });

    res.status(201).json({ success: true, payment });
  } catch (err) {
    console.error("createIntent error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Sunucu hatası" });
  }
};

exports.getMyPayments = async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    const result = await paymentService.getMyPayments({ userId: req.user.id, page, limit });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("getMyPayments error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.getMyPaymentByOrderId = async (req, res) => {
  try {
    const payment = await paymentService.getMyPaymentByOrderId({ userId: req.user.id, orderId: req.params.orderId });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Ödeme bulunamadı" });
    }

    res.json({ success: true, payment });
  } catch (err) {
    console.error("getMyPaymentByOrderId error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.confirmMyPaymentByOrderId = async (req, res) => {
  try {
    const payment = await paymentService.confirmPaymentByOrderId({
      userId: req.user.id,
      orderId: req.params.orderId,
    });

    res.json({ success: true, payment });
  } catch (err) {
    console.error("confirmMyPaymentByOrderId error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Sunucu hatası" });
  }
};

exports.webhook = async (req, res) => {
  try {
    const body = req.body || {};
    const normalizedProvider = String(body.provider || req.query.provider || "").trim().toLowerCase();

    const provider = normalizedProvider || (body.type && String(body.type).startsWith("checkout.session") ? "stripe" : "mock");

    const signature = provider === "stripe"
      ? req.headers["stripe-signature"]
      : req.headers["x-eyra-signature"];

    let mappedPayload = body;
    let eventId = body.eventId;
    let eventType = body.eventType;
    let providerPaymentId = body.providerPaymentId;
    let orderId = body.orderId;
    let status = body.status;
    let amountMinor = body.amountMinor;

    if (provider === "stripe") {
      eventId = body.id;
      eventType = body.type;

      const object = body.data?.object || {};
      providerPaymentId = object.id;
      orderId = object.client_reference_id || object.metadata?.orderId;
      amountMinor = object.amount_total;

      if (eventType === "checkout.session.completed") {
        status = "paid";
      } else if (eventType === "checkout.session.expired" || eventType === "checkout.session.async_payment_failed") {
        status = "failed";
      }

      mappedPayload = {
        ...body,
        rawBody: req.rawBody || "",
      };
    }

    const result = await paymentService.processWebhook({
      provider,
      eventId,
      eventType,
      providerPaymentId,
      orderId,
      status,
      amountMinor,
      signature,
      payload: mappedPayload,
    });

    res.json({ success: true, duplicate: result.duplicate, payment: result.payment });
  } catch (err) {
    console.error("payment webhook error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Sunucu hatası" });
  }
};

exports.refundPayment = async (req, res) => {
  try {
    const payment = await paymentService.refundPayment({ orderId: req.params.orderId });
    res.json({ success: true, payment });
  } catch (err) {
    console.error("refundPayment error:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Sunucu hatası" });
  }
};

exports.mockCheckout = async (req, res) => {
  try {
    const providerPaymentId = String(req.query.providerPaymentId || "").trim();
    if (!providerPaymentId) {
      return res.status(400).send("providerPaymentId zorunlu");
    }

    const payment = await Payment.findOne({ providerPaymentId }).lean();
    if (!payment) {
      return res.status(404).send("Ödeme bulunamadı");
    }

    const completePaid = `/api/payments/mock-complete?providerPaymentId=${encodeURIComponent(providerPaymentId)}&status=paid`;
    const completeFailed = `/api/payments/mock-complete?providerPaymentId=${encodeURIComponent(providerPaymentId)}&status=failed`;

    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Mock Checkout</title></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto;">
  <h2>Mock Checkout</h2>
  <p><strong>Order:</strong> ${payment.orderId}</p>
  <p><strong>Tutar:</strong> ${(payment.amountMinor / 100).toFixed(2)} ${payment.currency}</p>
  <p><strong>Yöntem:</strong> ${payment.method}</p>
  <a href="${completePaid}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:8px;margin-right:8px;">Ödemeyi Başarılı Tamamla</a>
  <a href="${completeFailed}" style="display:inline-block;padding:10px 16px;background:#777;color:#fff;text-decoration:none;border-radius:8px;">Ödemeyi Başarısız Tamamla</a>
  <p style="margin-top:16px;color:#555;">Bu ekran sadece sandbox/mock içindir.</p>
</body>
</html>`);
  } catch (err) {
    console.error("mockCheckout error:", err);
    return res.status(500).send("Sunucu hatası");
  }
};

exports.adminGetPayments = async (req, res) => {
  try {
    const Payment = require("../models/Payment");
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const status = req.query.status ? String(req.query.status).trim() : null;
    const productType = req.query.productType ? String(req.query.productType).trim() : null;
    const userId = req.query.userId ? String(req.query.userId).trim() : null;

    const query = {};
    if (status) query.status = status;
    if (productType) query.productType = productType;
    if (userId) query.user = userId;

    const total = await Payment.countDocuments(query);
    const payments = await Payment.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("user", "username name email coins")
      .lean();

    res.json({
      success: true,
      payments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("adminGetPayments error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.adminGetStats = async (req, res) => {
  try {
    const Payment = require("../models/Payment");

    const [total, paid, failed, refunded, pending] = await Promise.all([
      Payment.countDocuments({}),
      Payment.countDocuments({ status: "paid" }),
      Payment.countDocuments({ status: "failed" }),
      Payment.countDocuments({ status: "refunded" }),
      Payment.countDocuments({ status: { $in: ["created", "pending"] } }),
    ]);

    const revenueAgg = await Payment.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: "$currency", total: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]);

    const byProductType = await Payment.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: "$productType", total: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]);

    res.json({
      success: true,
      stats: {
        total, paid, failed, refunded, pending,
        revenue: revenueAgg,
        byProductType,
      },
    });
  } catch (err) {
    console.error("adminGetStats error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

exports.mockComplete = async (req, res) => {
  try {
    const providerPaymentId = String(req.query.providerPaymentId || "").trim();
    const status = String(req.query.status || "paid").trim().toLowerCase();

    if (!providerPaymentId || !["paid", "failed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Geçersiz query" });
    }

    const payment = await Payment.findOne({ providerPaymentId }).lean();
    if (!payment) {
      return res.status(404).json({ success: false, message: "Ödeme bulunamadı" });
    }

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const signature = paymentService.signMockWebhook({
      eventId,
      providerPaymentId: payment.providerPaymentId,
      status,
      amountMinor: payment.amountMinor,
    }, PAYMENT_WEBHOOK_SECRET || "dev_payment_webhook_secret");

    const result = await paymentService.processWebhook({
      provider: "mock",
      eventId,
      eventType: `payment.${status}`,
      providerPaymentId: payment.providerPaymentId,
      orderId: payment.orderId,
      status,
      amountMinor: payment.amountMinor,
      signature,
      payload: {
        source: "mock-checkout",
      },
    });

    const target = status === "paid"
      ? (PAYMENT_SUCCESS_URL || "eyra://payment/success")
      : (PAYMENT_CANCEL_URL || "eyra://payment/cancel");

    if (target.startsWith("http://") || target.startsWith("https://")) {
      return res.redirect(target);
    }

    return res.json({ success: true, redirect: target, payment: result.payment });
  } catch (err) {
    console.error("mockComplete error:", err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Sunucu hatası" });
  }
};
