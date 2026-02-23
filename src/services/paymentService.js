const { randomUUID } = require("crypto");
const Payment = require("../models/Payment");
const PaymentEvent = require("../models/PaymentEvent");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { getCatalogItem, getPublicCatalog } = require("../config/paymentCatalog");
const mockProvider = require("./paymentProviders/mockProvider");
const stripeProvider = require("./paymentProviders/stripeProvider");
const {
  PAYMENT_PROVIDER,
  PAYMENT_WEBHOOK_SECRET,
  PAYMENT_SUCCESS_URL,
  PAYMENT_CANCEL_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} = require("../config/env");

const ACTIVE_PAYMENT_PROVIDER = String(PAYMENT_PROVIDER || "mock").trim().toLowerCase();
const WEBHOOK_SECRET = String(PAYMENT_WEBHOOK_SECRET || "dev_payment_webhook_secret");

const pickProvider = (paymentMethod) => {
  const method = String(paymentMethod || "").trim().toLowerCase();

  if (method === "crypto") {
    return "mock";
  }

  if (!["mock", "stripe"].includes(ACTIVE_PAYMENT_PROVIDER)) {
    const err = new Error("Geçersiz PAYMENT_PROVIDER. Desteklenen: mock, stripe");
    err.statusCode = 500;
    throw err;
  }

  return ACTIVE_PAYMENT_PROVIDER;
};

const makeOrderId = () => `ord_${Date.now()}_${randomUUID().slice(0, 8)}`;

const getCatalog = () => getPublicCatalog();

const createPaymentIntent = async ({ userId, productCode, method, idempotencyKey }) => {
  const item = getCatalogItem(productCode);
  if (!item) {
    const err = new Error("Geçersiz productCode");
    err.statusCode = 400;
    throw err;
  }

  const paymentMethod = String(method || "").trim().toLowerCase();
  if (!item.enabledMethods.includes(paymentMethod)) {
    const err = new Error("Bu ürün seçilen ödeme yöntemiyle desteklenmiyor");
    err.statusCode = 400;
    throw err;
  }

  const idemKey = String(idempotencyKey || "").trim() || null;

  if (idemKey) {
    const existing = await Payment.findOne({ user: userId, idempotencyKey: idemKey }).lean();
    if (existing) {
      return existing;
    }
  }

  const provider = pickProvider(paymentMethod);
  const orderId = makeOrderId();

  const successUrl = PAYMENT_SUCCESS_URL || "eyra://payment/success";
  const cancelUrl = PAYMENT_CANCEL_URL || "eyra://payment/cancel";

  let checkout;
  if (provider === "mock") {
    checkout = await mockProvider.createCheckout({
      orderId,
      method: paymentMethod,
      amountMinor: item.amountMinor,
      currency: item.currency,
      successUrl,
      cancelUrl,
    });
  } else if (provider === "stripe") {
    if (paymentMethod !== "card") {
      const err = new Error("Stripe provider şu an yalnızca card method destekliyor");
      err.statusCode = 400;
      throw err;
    }

    checkout = await stripeProvider.createCheckout({
      secretKey: STRIPE_SECRET_KEY,
      orderId,
      amountMinor: item.amountMinor,
      currency: item.currency,
      title: item.title,
      successUrl,
      cancelUrl,
      metadata: {
        orderId,
        productCode: item.code,
        productType: item.productType,
      },
    });
  }

  if (!checkout) {
    const err = new Error("Checkout oluşturulamadı");
    err.statusCode = 500;
    throw err;
  }

  const created = await Payment.create({
    user: userId,
    orderId,
    idempotencyKey: idemKey,
    provider,
    method: paymentMethod,
    productCode: item.code,
    productType: item.productType,
    amountMinor: item.amountMinor,
    currency: item.currency,
    providerPaymentId: checkout.providerPaymentId,
    providerCheckoutUrl: checkout.checkoutUrl,
    status: checkout.status,
    metadata: {
      title: item.title,
      coins: item.coins || 0,
      vipDays: item.vipDays || 0,
    },
  });

  return created.toObject();
};

const applyPaidEffects = async (paymentDoc) => {
  const session = await Payment.startSession();
  try {
    await session.withTransaction(async () => {
      const lockedPayment = await Payment.findById(paymentDoc._id).session(session);
      if (!lockedPayment || lockedPayment.status === "paid") return;

      const user = await User.findById(lockedPayment.user).session(session);
      if (!user) {
        const err = new Error("Ödeme kullanıcısı bulunamadı");
        err.statusCode = 404;
        throw err;
      }

      if (lockedPayment.productType === "coin_topup") {
        const coins = Number(lockedPayment.metadata?.coins || 0);
        if (coins <= 0) {
          const err = new Error("Coin paketi verisi geçersiz");
          err.statusCode = 500;
          throw err;
        }

        user.coins = Number(user.coins || 0) + coins;
        await user.save({ session });

        await Transaction.create(
          [
            {
              user: user._id,
              type: "purchase",
              amount: coins,
              balanceAfter: user.coins,
              status: "completed",
              description: `${lockedPayment.metadata?.title || "Coin topup"} satın alındı`,
              metadata: {
                orderId: lockedPayment.orderId,
                provider: lockedPayment.provider,
                providerPaymentId: lockedPayment.providerPaymentId,
                paymentAmountMinor: lockedPayment.amountMinor,
                currency: lockedPayment.currency,
              },
            },
          ],
          { session }
        );
      }

      if (lockedPayment.productType === "vip") {
        const vipDays = Number(lockedPayment.metadata?.vipDays || 0);
        const baseDate = user.vipExpiresAt && user.vipExpiresAt > new Date() ? user.vipExpiresAt : new Date();

        user.isVip = true;
        user.vipTier = user.vipTier === "none" ? "silver" : user.vipTier;
        user.vipPurchasedAt = new Date();
        user.vipExpiresAt = new Date(baseDate.getTime() + vipDays * 24 * 60 * 60 * 1000);
        await user.save({ session });

        await Transaction.create(
          [
            {
              user: user._id,
              type: "vip_purchase",
              amount: 0,
              status: "completed",
              description: `${lockedPayment.metadata?.title || "VIP"} satın alındı`,
              metadata: {
                orderId: lockedPayment.orderId,
                vipDays,
                vipExpiresAt: user.vipExpiresAt,
                provider: lockedPayment.provider,
              },
            },
          ],
          { session }
        );
      }

      lockedPayment.status = "paid";
      lockedPayment.paidAt = new Date();
      await lockedPayment.save({ session });
    });
  } finally {
    await session.endSession();
  }
};

const processWebhook = async ({ provider, eventId, eventType, providerPaymentId, orderId, status, amountMinor, signature, payload }) => {
  const providerName = String(provider || "").trim().toLowerCase();
  if (providerName === "stripe") {
    const stripeEventId = String(eventId || "").trim();
    if (!stripeEventId) {
      const err = new Error("Stripe webhook eventId zorunlu");
      err.statusCode = 400;
      throw err;
    }

    const sessionId = String(providerPaymentId || "").trim();
    if (!sessionId) {
      const err = new Error("Stripe webhook providerPaymentId(session.id) zorunlu");
      err.statusCode = 400;
      throw err;
    }

    const existingStripeEvent = await PaymentEvent.findOne({ eventId: stripeEventId }).lean();
    if (existingStripeEvent) {
      const existingPayment = await Payment.findOne({ provider: "stripe", providerPaymentId: sessionId }).lean();
      return { payment: existingPayment, duplicate: true };
    }

    const isSignatureValid = stripeProvider.verifyWebhookSignature({
      payload: String(payload?.rawBody || ""),
      signatureHeader: signature,
      webhookSecret: STRIPE_WEBHOOK_SECRET,
    });

    if (!isSignatureValid) {
      const err = new Error("Geçersiz Stripe webhook signature");
      err.statusCode = 401;
      throw err;
    }

    const payment = await Payment.findOne({ provider: "stripe", providerPaymentId: sessionId });
    if (!payment) {
      const err = new Error("Stripe webhook için ödeme bulunamadı");
      err.statusCode = 404;
      throw err;
    }

    await PaymentEvent.create({
      payment: payment._id,
      provider: "stripe",
      eventId: stripeEventId,
      eventType: String(eventType || "stripe.event"),
      providerPaymentId: sessionId,
      isSignatureValid: true,
      payload: payload || {},
      processedAt: new Date(),
    });

    const normalizedType = String(eventType || "").trim().toLowerCase();

    if (normalizedType === "checkout.session.completed") {
      await applyPaidEffects(payment);
    }

    if (normalizedType === "checkout.session.expired" || normalizedType === "checkout.session.async_payment_failed") {
      payment.status = "failed";
      payment.failedAt = new Date();
      await payment.save();
    }

    const latestStripePayment = await Payment.findById(payment._id).lean();
    return { payment: latestStripePayment, duplicate: false };
  }

  if (providerName !== "mock") {
    const err = new Error("Bilinmeyen provider");
    err.statusCode = 400;
    throw err;
  }

  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (!["paid", "failed", "refunded"].includes(normalizedStatus)) {
    const err = new Error("Geçersiz webhook status");
    err.statusCode = 400;
    throw err;
  }

  const webhookEventId = String(eventId || "").trim();
  if (!webhookEventId) {
    const err = new Error("eventId zorunlu");
    err.statusCode = 400;
    throw err;
  }

  const paymentQuery = providerPaymentId
    ? { provider: providerName, providerPaymentId: String(providerPaymentId) }
    : { provider: providerName, orderId: String(orderId || "") };
  const payment = await Payment.findOne(paymentQuery);

  if (!payment) {
    const err = new Error("Ödeme bulunamadı");
    err.statusCode = 404;
    throw err;
  }

  const existingEvent = await PaymentEvent.findOne({ eventId: webhookEventId }).lean();
  if (existingEvent) {
    return { payment: payment.toObject(), duplicate: true };
  }

  const isSignatureValid = mockProvider.verifyWebhookSignature(
    {
      eventId: webhookEventId,
      providerPaymentId: payment.providerPaymentId,
      status: normalizedStatus,
      amountMinor: Number(amountMinor || payment.amountMinor),
      signature,
    },
    WEBHOOK_SECRET
  );

  if (!isSignatureValid) {
    const err = new Error("Geçersiz webhook signature");
    err.statusCode = 401;
    throw err;
  }

  await PaymentEvent.create({
    payment: payment._id,
    provider: providerName,
    eventId: webhookEventId,
    eventType: String(eventType || normalizedStatus),
    providerPaymentId: payment.providerPaymentId,
    isSignatureValid,
    payload: payload || {},
    processedAt: new Date(),
  });

  if (normalizedStatus === "paid") {
    await applyPaidEffects(payment);
  }

  if (normalizedStatus === "failed") {
    payment.status = "failed";
    payment.failedAt = new Date();
    await payment.save();
  }

  if (normalizedStatus === "refunded") {
    payment.status = "refunded";
    payment.refundedAt = new Date();
    await payment.save();
  }

  const latestPayment = await Payment.findById(payment._id).lean();
  return { payment: latestPayment, duplicate: false };
};

const getMyPayments = async ({ userId, page = 1, limit = 20 }) => {
  const normalizedPage = Math.max(Number(page) || 1, 1);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const query = { user: userId };
  const total = await Payment.countDocuments(query);
  const payments = await Payment.find(query)
    .sort({ createdAt: -1 })
    .skip((normalizedPage - 1) * normalizedLimit)
    .limit(normalizedLimit)
    .lean();

  return {
    items: payments,
    pagination: {
      page: normalizedPage,
      limit: normalizedLimit,
      total,
      pages: Math.ceil(total / normalizedLimit),
    },
  };
};

const getMyPaymentByOrderId = async ({ userId, orderId }) => {
  return Payment.findOne({ user: userId, orderId: String(orderId || "") }).lean();
};

const confirmPaymentByOrderId = async ({ userId, orderId }) => {
  const payment = await Payment.findOne({ user: userId, orderId: String(orderId || "") });
  if (!payment) {
    const err = new Error("Ödeme bulunamadı");
    err.statusCode = 404;
    throw err;
  }

  if (payment.status === "paid" || payment.status === "failed" || payment.status === "refunded") {
    return payment.toObject();
  }

  if (payment.provider === "stripe") {
    const session = await stripeProvider.retrieveCheckoutSession({
      secretKey: STRIPE_SECRET_KEY,
      sessionId: payment.providerPaymentId,
    });

    const sessionStatus = String(session.status || "").trim().toLowerCase();
    const paymentStatus = String(session.payment_status || "").trim().toLowerCase();

    if (sessionStatus === "complete" && paymentStatus === "paid") {
      await applyPaidEffects(payment);
      const latestPaid = await Payment.findById(payment._id).lean();
      return latestPaid;
    }

    if (sessionStatus === "expired") {
      payment.status = "failed";
      payment.failedAt = new Date();
      await payment.save();
      return payment.toObject();
    }
  }

  return payment.toObject();
};

const refundPayment = async ({ orderId }) => {
  const payment = await Payment.findOne({ orderId: String(orderId || "") });
  if (!payment) {
    const err = new Error("Ödeme bulunamadı");
    err.statusCode = 404;
    throw err;
  }

  if (payment.status !== "paid") {
    const err = new Error("Sadece paid ödemeler iade edilebilir");
    err.statusCode = 409;
    throw err;
  }

  payment.status = "refunded";
  payment.refundedAt = new Date();
  await payment.save();

  await Transaction.create({
    user: payment.user,
    type: "refund",
    amount: 0,
    status: "completed",
    description: `Refund işlendi: ${payment.orderId}`,
    metadata: {
      orderId: payment.orderId,
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    },
  });

  return payment.toObject();
};

module.exports = {
  getCatalog,
  createPaymentIntent,
  processWebhook,
  getMyPayments,
  getMyPaymentByOrderId,
  confirmPaymentByOrderId,
  refundPayment,
  signMockWebhook: mockProvider.signWebhook,
};
