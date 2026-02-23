const paymentCatalog = Object.freeze({
  coin_1000_try: {
    code: "coin_1000_try",
    title: "1000 Coin",
    productType: "coin_topup",
    coins: 1000,
    amountMinor: 99900,
    currency: "TRY",
    enabledMethods: ["card", "crypto"],
  },
  coin_2500_try: {
    code: "coin_2500_try",
    title: "2500 Coin",
    productType: "coin_topup",
    coins: 2500,
    amountMinor: 199900,
    currency: "TRY",
    enabledMethods: ["card", "crypto"],
  },
  vip_monthly_try: {
    code: "vip_monthly_try",
    title: "VIP Monthly",
    productType: "vip",
    vipDays: 30,
    amountMinor: 299900,
    currency: "TRY",
    enabledMethods: ["card"],
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
  }));
};

module.exports = {
  paymentCatalog,
  getCatalogItem,
  getPublicCatalog,
};
