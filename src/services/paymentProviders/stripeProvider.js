const axios = require("axios");
const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const assertSecretKey = (secretKey) => {
  const key = String(secretKey || "").trim();
  if (!key) {
    const err = new Error("STRIPE_SECRET_KEY tanımlı değil");
    err.statusCode = 500;
    throw err;
  }
  return key;
};

const createCheckout = async ({
  secretKey,
  orderId,
  amountMinor,
  currency,
  title,
  successUrl,
  cancelUrl,
  metadata,
}) => {
  const key = assertSecretKey(secretKey);

  const form = new URLSearchParams();
  form.append("mode", "payment");
  form.append("client_reference_id", orderId);
  form.append("success_url", successUrl);
  form.append("cancel_url", cancelUrl);

  form.append("line_items[0][quantity]", "1");
  form.append("line_items[0][price_data][currency]", String(currency || "TRY").toLowerCase());
  form.append("line_items[0][price_data][unit_amount]", String(amountMinor));
  form.append("line_items[0][price_data][product_data][name]", String(title || "EYRA Purchase"));

  if (metadata && typeof metadata === "object") {
    for (const [k, v] of Object.entries(metadata)) {
      form.append(`metadata[${k}]`, String(v));
    }
  }

  const response = await axios.post(`${STRIPE_API_BASE}/checkout/sessions`, form.toString(), {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });

  return {
    providerPaymentId: response.data.id,
    checkoutUrl: response.data.url,
    status: "pending",
  };
};

const retrieveCheckoutSession = async ({ secretKey, sessionId }) => {
  const key = assertSecretKey(secretKey);
  const sid = String(sessionId || "").trim();

  if (!sid) {
    const err = new Error("sessionId zorunlu");
    err.statusCode = 400;
    throw err;
  }

  const response = await axios.get(`${STRIPE_API_BASE}/checkout/sessions/${sid}`, {
    headers: {
      Authorization: `Bearer ${key}`,
    },
    timeout: 15000,
  });

  return response.data;
};

const verifyWebhookSignature = ({ payload, signatureHeader, webhookSecret, toleranceSeconds = 300 }) => {
  const secret = String(webhookSecret || "").trim();
  const rawPayload = typeof payload === "string" ? payload : "";
  const header = String(signatureHeader || "").trim();

  if (!secret || !rawPayload || !header) return false;

  const pairs = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, value] = part.split("=");
      return { key, value };
    });

  const timestamp = pairs.find((p) => p.key === "t")?.value;
  const signatures = pairs.filter((p) => p.key === "v1").map((p) => p.value).filter(Boolean);

  if (!timestamp || signatures.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return false;
  }

  const signedPayload = `${timestamp}.${rawPayload}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  return signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
    } catch {
      return false;
    }
  });
};

module.exports = {
  createCheckout,
  retrieveCheckoutSession,
  verifyWebhookSignature,
};
