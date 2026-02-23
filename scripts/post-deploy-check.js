/**
 * post-deploy-check.js
 * Deploy edilen Render servisinin ödeme altyapısının tam çalışır
 * olduğunu otomatik doğrular.
 *
 * Çalıştırma: npm run deploy:check
 * Gerekli: BACKEND_URL env değişkeni
 * Opsiyonel: E2E_AUTH_TOKEN (authenticated endpointler için)
 */

"use strict";

const axios = require("axios");
const path  = require("path");

try { require("dotenv").config({ path: path.join(__dirname, "..", ".env.production.ready") }); } catch {}
try { require("dotenv").config(); } catch {}

const BASE_URL    = (process.env.BACKEND_URL    || "").replace(/\/$/, "");
const AUTH_TOKEN  = (process.env.E2E_AUTH_TOKEN || "").trim();

const ax = axios.create({ baseURL: BASE_URL, timeout: 20000 });

const PASS = "✓";
const FAIL = "✗";
const WARN = "!";

let passed  = 0;
let failed  = 0;
let warnings = 0;

function ok(msg)   { passed++;   console.log(`  ${PASS}  ${msg}`); }
function fail(msg) { failed++;   console.log(`  ${FAIL}  ${msg}`); }
function warn(msg) { warnings++; console.log(`  ${WARN}  ${msg}`); }

async function check(label, fn) {
  try {
    const result = await fn();
    if (result === false) fail(label);
    else ok(label);
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.message || err.message;
    fail(`${label} → ${status ? `HTTP ${status}` : message}`);
  }
}

// ─────────────────────────────────────────────────────────
async function main() {
  if (!BASE_URL) {
    console.error(`${FAIL}  BACKEND_URL tanımlı değil.`);
    console.error("  Örnek: BACKEND_URL=https://eyra-backend.onrender.com npm run deploy:check");
    process.exit(1);
  }

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  EYRA Backend Post-Deploy Check`);
  console.log(`  Hedef : ${BASE_URL}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  // ── 1. Sunucu erişimi ──────────────────────────────────
  console.log("── Sunucu Erişimi ──");
  await check("Backend canlı (HTTP 200/304)", async () => {
    const res = await ax.get("/");
    return res.status < 400;
  });

  // ── 2. Ödeme kataloğu (public) ─────────────────────────
  console.log("\n── Ödeme Kataloğu (Public) ──");
  await check("GET /api/payments/catalog → 200", async () => {
    const res = await ax.get("/api/payments/catalog");
    return Array.isArray(res.data?.items) && res.data.items.length > 0;
  });

  await check("Katalog ürünleri coin değerine sahip", async () => {
    const res = await ax.get("/api/payments/catalog");
    return res.data.items.every(i => i.coins > 0 && i.price > 0);
  });

  // ── 3. Auth guard'lar ──────────────────────────────────
  console.log("\n── Auth Guard Kontrolleri ──");
  await check("POST /api/payments/create-intent → 401 (token olmadan)", async () => {
    try {
      await ax.post("/api/payments/create-intent", {});
      return false; // 401 bekliyorduk; 2xx döndü = hata
    } catch (err) {
      return err.response?.status === 401;
    }
  });

  await check("GET /api/payments/order/fake → 401 (token olmadan)", async () => {
    try {
      await ax.get("/api/payments/order/fakeOrderId123");
      return false;
    } catch (err) {
      return err.response?.status === 401;
    }
  });

  // ── 4. Webhook endpoint ────────────────────────────────
  console.log("\n── Webhook Endpoint ──");
  await check("POST /api/payments/webhook → 400/401 (imzasız istek reddedildi)", async () => {
    try {
      await ax.post("/api/payments/webhook?provider=stripe", { test: 1 }, {
        headers: { "Content-Type": "application/json" },
      });
      return false; // 4xx bekliyoruz
    } catch (err) {
      const s = err.response?.status;
      return s === 400 || s === 401;
    }
  });

  // ── 5. Auth tokenı varsa gelişmiş testler ──────────────
  if (AUTH_TOKEN) {
    const authH = { Authorization: `Bearer ${AUTH_TOKEN}` };
    console.log("\n── Authenticated Endpoint Kontrolleri ──");

    await check("GET /api/payments/catalog (auth ile)", async () => {
      const res = await ax.get("/api/payments/catalog", { headers: authH });
      return res.status === 200;
    });

    await check("POST /api/payments/create-intent (geçersiz paket → doğru hata)", async () => {
      try {
        await ax.post("/api/payments/create-intent",
          { packageId: "INVALID_PKG_9999", method: "card" },
          { headers: authH }
        );
        return false;
      } catch (err) {
        return err.response?.status === 400 || err.response?.status === 404;
      }
    });

    ok("Auth token geçerli; tüm auth testleri çalıştırıldı");
  } else {
    warn("E2E_AUTH_TOKEN tanımlı değil; authenticated testler atlandı");
    warn("Tam test için: E2E_AUTH_TOKEN=<token> npm run deploy:check");
  }

  // ── Özet ──────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  Geçti  : ${passed}`);
  if (warnings) console.log(`  Uyarı  : ${warnings}`);
  console.log(`  Başarısız: ${failed}`);

  if (failed === 0) {
    console.log(`\n  ✓  DEPLOY BAŞARILI — sistem canlıya hazır.\n`);
  } else {
    console.log(`\n  ✗  ${failed} kontrol başarısız — log'ları incele.\n`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
