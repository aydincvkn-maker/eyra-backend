const paymentCatalog = Object.freeze({
  coin_500_usd: {
    code: "coin_500_usd",
    title: "500 Coin",
    productType: "coin_topup",
    coins: 500,
    amountMinor: 500,
    currency: "USD",
    enabledMethods: ["card", "crypto"],
    badge: null,
  },
  coin_1000_usd: {
    code: "coin_1000_usd",
    title: "1000 Coin",
    productType: "coin_topup",
    coins: 1000,
    amountMinor: 800,
    currency: "USD",
    enabledMethods: ["card", "crypto"],
    badge: "popular",
  },
  coin_2500_usd: {
    code: "coin_2500_usd",
    title: "2500 Coin",
    productType: "coin_topup",
    coins: 2500,
    amountMinor: 1200,
    currency: "USD",
    enabledMethods: ["card", "crypto"],
    badge: null,
  },
  coin_5000_usd: {
    code: "coin_5000_usd",
    title: "5000 Coin",
    productType: "coin_topup",
    coins: 5000,
    amountMinor: 2000,
    currency: "USD",
    enabledMethods: ["card", "crypto"],
    badge: null,
  },
  coin_8000_usd: {
    code: "coin_8000_usd",
    title: "8000 Coin",
    productType: "coin_topup",
    coins: 8000,
    amountMinor: 3000,
    currency: "USD",
    enabledMethods: ["card", "crypto"],
    badge: "best_value",
  },
  coin_15000_usd: {
    code: "coin_15000_usd",
    title: "15000 Coin",
    productType: "coin_topup",
    coins: 15000,
    amountMinor: 5500,
    currency: "USD",
    enabledMethods: ["card", "crypto"],
    badge: null,
  },
  vip_monthly_usd: {
    code: "vip_monthly_usd",
    title: "VIP Monthly",
    productType: "vip",
    vipDays: 30,
    amountMinor: 999,
    currency: "USD",
    enabledMethods: ["card"],
    badge: null,
  },
});

const getCatalogItem = (code) => {
  const key = String(code || "").trim();
  return paymentCatalog[key] || null;
};

const getPublicCatalog = () => {
  return Object.values(paymentCatalog).map((item) => ({
    code: item.code,
    title: item.title,
    productType: item.productType,
    coins: item.coins || 0,
    vipDays: item.vipDays || 0,
    amountMinor: item.amountMinor,
    currency: item.currency,
    enabledMethods: item.enabledMethods,
    badge: item.badge || null,
  }));
};

module.exports = {
  paymentCatalog,
  getCatalogItem,
  getPublicCatalog,
};
