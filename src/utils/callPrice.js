// src/utils/callPrice.js

/**
 * Kadın kullanıcının seviyesine göre dakika başı görüntülü arama ücreti (coin).
 *
 * Level 1  → 70 coin/dk
 * Level 2  → 80 coin/dk
 * Level 3  → 90 coin/dk
 * ... her level için +10 coin/dk
 * Maksimum: 300 coin/dk (level 24+)
 */
function callPriceForLevel(level) {
  const safeLevel = Math.max(1, Math.min(Math.floor(Number(level) || 1), 100));
  const price = 60 + safeLevel * 10;
  return Math.min(price, 300);
}

module.exports = { callPriceForLevel };
