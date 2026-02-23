const axios = require("axios");

const BACKEND_URL = String(process.env.BACKEND_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const AUTH_TOKEN = String(process.env.E2E_AUTH_TOKEN || "").trim();
const METHOD = String(process.env.PAYMENT_METHOD || "card").trim().toLowerCase();
const PRODUCT_CODE = String(process.env.PAYMENT_PRODUCT_CODE || "").trim();

const authHeaders = () => ({
  "Content-Type": "application/json",
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
});

const fail = (message, details) => {
  console.error(`❌ ${message}`);
  if (details) {
    console.error(details);
  }
  process.exit(1);
};

const run = async () => {
  console.log(`🔎 Backend: ${BACKEND_URL}`);

  const catalogResp = await axios.get(`${BACKEND_URL}/api/payments/catalog`, {
    timeout: 15000,
    validateStatus: () => true,
  });

  if (catalogResp.status !== 200 || !catalogResp.data?.success) {
    fail("Catalog endpoint başarısız", catalogResp.data || catalogResp.statusText);
  }

  const catalog = Array.isArray(catalogResp.data.catalog) ? catalogResp.data.catalog : [];
  if (catalog.length === 0) {
    fail("Catalog boş döndü");
  }

  const selectedProduct = PRODUCT_CODE
    ? catalog.find((item) => item.code === PRODUCT_CODE)
    : catalog.find((item) => item.productType === "coin_topup" && Array.isArray(item.enabledMethods) && item.enabledMethods.includes(METHOD));

  if (!selectedProduct) {
    fail(`Uygun ürün bulunamadı (method=${METHOD}, productCode=${PRODUCT_CODE || "auto"})`);
  }

  console.log(`✅ Catalog bulundu: ${selectedProduct.code} (${selectedProduct.amountMinor / 100} ${selectedProduct.currency})`);

  if (!AUTH_TOKEN) {
    console.log("ℹ️ E2E_AUTH_TOKEN tanımlı değil, sadece public catalog testi yapıldı.");
    return;
  }

  const intentResp = await axios.post(
    `${BACKEND_URL}/api/payments/intents`,
    {
      productCode: selectedProduct.code,
      method: METHOD,
      idempotencyKey: `smoke-${Date.now()}`,
    },
    {
      headers: authHeaders(),
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (intentResp.status !== 201 || !intentResp.data?.success) {
    fail("Intent oluşturulamadı", intentResp.data || intentResp.statusText);
  }

  const payment = intentResp.data.payment || {};
  const orderId = String(payment.orderId || "");
  const provider = String(payment.provider || "");
  const providerPaymentId = String(payment.providerPaymentId || "");
  console.log(`✅ Intent oluşturuldu: orderId=${orderId}, provider=${provider}, method=${METHOD}`);

  if (!orderId) {
    fail("Intent response içinde orderId yok", payment);
  }

  if (provider === "mock" && providerPaymentId) {
    const completeResp = await axios.get(
      `${BACKEND_URL}/api/payments/mock-complete?providerPaymentId=${encodeURIComponent(providerPaymentId)}&status=paid`,
      {
        timeout: 15000,
        validateStatus: () => true,
        maxRedirects: 0,
      }
    );

    if (![200, 302].includes(completeResp.status)) {
      fail("Mock completion başarısız", completeResp.data || completeResp.statusText);
    }

    console.log("✅ Mock completion tetiklendi");
  } else {
    console.log("ℹ️ Provider mock değil. Checkout'u kullanıcı tamamlamalı, script sadece confirm + status kontrol eder.");
  }

  const confirmResp = await axios.post(
    `${BACKEND_URL}/api/payments/${encodeURIComponent(orderId)}/confirm`,
    {},
    {
      headers: authHeaders(),
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (confirmResp.status !== 200 || !confirmResp.data?.success) {
    fail("Confirm endpoint başarısız", confirmResp.data || confirmResp.statusText);
  }

  const statusResp = await axios.get(`${BACKEND_URL}/api/payments/${encodeURIComponent(orderId)}`, {
    headers: authHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });

  if (statusResp.status !== 200 || !statusResp.data?.success) {
    fail("Order status endpoint başarısız", statusResp.data || statusResp.statusText);
  }

  const finalStatus = String(statusResp.data?.payment?.status || "unknown");
  console.log(`✅ Final status: ${finalStatus}`);

  if (provider === "mock" && finalStatus !== "paid") {
    fail("Mock senaryoda final status paid olmalı", statusResp.data?.payment);
  }

  console.log("🎉 Payment smoke test tamamlandı");
};

run().catch((err) => {
  fail("Script hata verdi", err?.response?.data || err.message);
});
