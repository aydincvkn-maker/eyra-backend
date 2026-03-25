const PAYMENT_REDIRECT_PATTERNS = [
  /https?:\/\/\S+/i,
  /www\./i,
  /\b(?:iban|papara|wise|paypal|payoneer|stripe|crypto|usdt|btc|eth|binance|trc20|erc20)\b/i,
  /\b(?:whatsapp|telegram|discord|t\.me|wa\.me|linktr\.ee|bio\.link)\b/i,
];

const PAYMENT_REDIRECT_CONTEXT_PATTERNS = [
  /\b(?:webden|siteden|siteye|tarayicidan|browserdan|disaridan|uygulama disindan|linkten)\b/i,
  /\b(?:web|site|link|tarayici|browser)\b/i,
];

const PAYMENT_ACTION_PATTERNS = [
  /\b(?:coin yukle|coin al|coin satin al|satin al|odeme yap|para gonder|gonder para|ucuz)\b/i,
  /\b(?:odeme|coin|bakiye|paket|yukleme|satinal|satinalma)\b/i,
];

const normalizeForModeration = (text) => {
  return String(text || "")
    .toLowerCase()
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i")
    .replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s")
    .replace(/[üÜ]/g, "u")
    .replace(/\s+/g, " ")
    .trim();
};

const containsPaymentRedirect = (text) => {
  const normalized = normalizeForModeration(text);
  if (!normalized) return false;

  const hasExplicitToken = PAYMENT_REDIRECT_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  if (hasExplicitToken) return true;

  const hasRedirectContext = PAYMENT_REDIRECT_CONTEXT_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasPaymentContext = PAYMENT_ACTION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );

  return hasRedirectContext && hasPaymentContext;
};

module.exports = {
  normalizeForModeration,
  containsPaymentRedirect,
};