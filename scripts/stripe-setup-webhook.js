/**
 * stripe-setup-webhook.js
 * Stripe webhook endpoint'ini Stripe API üzerinden otomatik oluşturur.
 * Çalıştırma: npm run stripe:setup-webhook
 *
 * Gerekli env değişkenleri:
 *   STRIPE_SECRET_KEY  – sk_live_... veya sk_test_...
 *   BACKEND_URL        – https://your-render-domain.onrender.com
 */

"use strict";

const axios = require("axios");
const path = require("path");

// .env.production.ready varsa yükle, yoksa process.env'i kullan
const envFile = path.join(__dirname, "..", ".env.production.ready");
try { require("dotenv").config({ path: envFile }); } catch {}
try { require("dotenv").config(); } catch {}

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const REQUIRED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
];

const log = (icon, msg) => console.log(`${icon}  ${msg}`);

async function stripePost(endpoint, data, secretKey) {
  return axios.post(`${STRIPE_API_BASE}${endpoint}`, new URLSearchParams(data).toString(), {
    headers: {
      Authorization:    `Bearer ${secretKey}`,
      "Content-Type":   "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });
}

async function stripeGet(endpoint, secretKey) {
  return axios.get(`${STRIPE_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    timeout: 15000,
  });
}

async function main() {
  const secretKey  = (process.env.STRIPE_SECRET_KEY  || "").trim();
  const backendUrl = (process.env.BACKEND_URL         || "").trim();

  const errors = [];
  if (!secretKey)                        errors.push("STRIPE_SECRET_KEY tanımlı değil");
  if (secretKey.includes("CHANGE_ME"))   errors.push("STRIPE_SECRET_KEY hâlâ placeholder");
  if (!backendUrl)                       errors.push("BACKEND_URL tanımlı değil (örnek: https://eyra-backend.onrender.com)");
  if (backendUrl.includes("localhost"))  errors.push("BACKEND_URL localhost olamaz; Render URL'ini gir");

  if (errors.length) {
    errors.forEach(e => log("✗", e));
    process.exit(1);
  }

  const webhookEndpoint = `${backendUrl.replace(/\/$/, "")}/api/payments/webhook?provider=stripe`;

  log("→", `Stripe API'si kontrol ediliyor...`);

  // Mevcut webhook listesini çek
  let existing;
  try {
    const res = await stripeGet("/webhook_endpoints?limit=100", secretKey);
    existing = res.data.data || [];
  } catch (err) {
    log("✗", `Stripe API hatası: ${err.response?.data?.error?.message || err.message}`);
    process.exit(1);
  }

  const found = existing.find(wh => wh.url === webhookEndpoint);

  if (found) {
    log("✓", `Webhook zaten kayıtlı: ${found.url}`);
    log("✓", `ID: ${found.id}  |  Status: ${found.status}`);
    log("!", "Yeni bir webhook oluşturmadı. Mevcut signing secret'ı Render env'e gir.");
    console.log(`\n  STRIPE_WEBHOOK_SECRET = <Stripe Dashboard → Webhooks → ${found.id} → Signing secret>\n`);
    process.exit(0);
  }

  log("→", `Webhook oluşturuluyor: ${webhookEndpoint}`);

  const formData = {
    url:               webhookEndpoint,
    "enabled_events[]": undefined, // URLSearchParams ile array göndereceğiz
  };

  // URLSearchParams ile array parametresi
  const params = new URLSearchParams();
  params.append("url", webhookEndpoint);
  REQUIRED_EVENTS.forEach(ev => params.append("enabled_events[]", ev));
  params.append("description", "EYRA payment webhook (auto-registered)");

  let result;
  try {
    result = await axios.post(`${STRIPE_API_BASE}/webhook_endpoints`, params.toString(), {
      headers: {
        Authorization:  `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    });
  } catch (err) {
    log("✗", `Webhook oluşturulamadı: ${err.response?.data?.error?.message || err.message}`);
    process.exit(1);
  }

  const wh = result.data;
  const signingSecret = wh.secret;

  log("✓", `Webhook oluşturuldu!`);
  log("✓", `ID: ${wh.id}`);
  log("✓", `URL: ${wh.url}`);
  log("✓", `Events: ${REQUIRED_EVENTS.join(", ")}`);

  if (signingSecret) {
    console.log("\n" + "=".repeat(70));
    console.log("  STRIPE_WEBHOOK_SECRET (bunu Render env alanına yapıştır):");
    console.log(`  ${signingSecret}`);
    console.log("=".repeat(70));
    console.log("\n  Bu değer sadece şu an gösterilir; sonra Stripe'tan tekrar alamazsın.\n");
  } else {
    log("!", "Signing secret bu yanıtta dönmedi; Stripe Dashboard'dan manuel al.");
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
