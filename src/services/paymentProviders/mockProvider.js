const crypto = require("crypto");

const signWebhook = ({ eventId, providerPaymentId, status, amountMinor }, secret) => {
  const data = `${eventId}.${providerPaymentId}.${status}.${amountMinor}`;
  return crypto.createHmac("sha256", String(secret || "")).update(data).digest("hex");
};

const verifyWebhookSignature = ({ eventId, providerPaymentId, status, amountMinor, signature }, secret) => {
  const expected = signWebhook({ eventId, providerPaymentId, status, amountMinor }, secret);
  const provided = String(signature || "");
  if (!provided || !expected) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
};

const createCheckout = async ({ orderId, method, amountMinor, currency, successUrl, cancelUrl }) => {
  const providerPaymentId = `mock_${crypto.randomUUID().replace(/-/g, "")}`;
  const query = new URLSearchParams({
    orderId,
    providerPaymentId,
    method,
    amountMinor: String(amountMinor),
    currency,
    successUrl,
    cancelUrl,
  });

  return {
    providerPaymentId,
    checkoutUrl: `/api/payments/mock-checkout?${query.toString()}`,
    status: "pending",
  };
};

module.exports = {
  createCheckout,
  signWebhook,
  verifyWebhookSignature,
};
