const path = require("path");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config({ path: path.join(__dirname, "../.env") });

const BACKEND_URL = String(process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");
const provider = String(process.env.PAYMENT_PROVIDER || "mock").trim().toLowerCase();

const requiredBase = [
  "PAYMENT_PROVIDER",
  "PAYMENT_SUCCESS_URL",
  "PAYMENT_CANCEL_URL",
];

const requiredStripe = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
const requiredMock = ["PAYMENT_WEBHOOK_SECRET"];

const missing = [];
for (const key of requiredBase) {
  if (!String(process.env[key] || "").trim()) {
    missing.push(key);
  }
}

if (provider === "stripe") {
  for (const key of requiredStripe) {
    if (!String(process.env[key] || "").trim()) {
      missing.push(key);
    }
  }
} else {
  for (const key of requiredMock) {
    if (!String(process.env[key] || "").trim()) {
      missing.push(key);
    }
  }
}

const print = (ok, label, detail = "") => {
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${label}${detail ? `: ${detail}` : ""}`);
};

const checkEndpoint = async (url, label) => {
  try {
    const res = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    const ok = res.status >= 200 && res.status < 300;
    print(ok, label, `status=${res.status}`);
    return ok;
  } catch (e) {
    print(false, label, e.message);
    return false;
  }
};

const run = async () => {
  console.log(`🔎 PAYMENT_PROVIDER=${provider}`);

  if (missing.length > 0) {
    print(false, "Eksik env", missing.join(", "));
  } else {
    print(true, "Env değişkenleri tam");
  }

  const healthOk = await checkEndpoint(`${BACKEND_URL}/api/health`, "Health endpoint");
  const catalogOk = await checkEndpoint(`${BACKEND_URL}/api/payments/catalog`, "Catalog endpoint");

  const overall = missing.length === 0 && healthOk && catalogOk;
  if (!overall) {
    console.error("\n🚫 Payment readiness check FAIL");
    process.exit(1);
  }

  console.log("\n🎉 Payment readiness check PASS");
};

run().catch((err) => {
  console.error("❌ readiness script error:", err.message);
  process.exit(1);
});
