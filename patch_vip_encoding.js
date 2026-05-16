// patch_vip_encoding.js - Fix encoding issues in vipController.js
const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "src", "controllers", "vipController.js");
let content = fs.readFileSync(filePath, "utf8");

const replacements = [
  // VIP features in packages
  [/G[^n]*nde 2 [^\n]*ark [^\n]*evirme/g, "Günde 2 Otomatik Çeviri"],
  [/G[^n]*nde 3 [^\n]*ark [^\n]*evirme/g, "Günde 3 Otomatik Çeviri"],
  [/S[^\n]*n[^\n]*rs[^\n]*z [^\n]*ark [^\n]*evirme/g, "Sınırsız Otomatik Çeviri"],
  [/[^\n]*zel hediyeler/g, "Özel hediyeler"],
  [/[^\n]*ncelikli destek/g, "Öncelikli destek"],
  [/[^\n]*zel animasyonlar/g, "Özel animasyonlar"],
  // Error messages
  [/Paketler al[^\n]*namad[^\n]*/g, "Paketler alınamadı"],
  [/Kullan[^\n]*c[^\n]* bulunamad[^\n]*/g, "Kullanıcı bulunamadı"],
  [/Ge[^\n]*ersiz VIP tipi/g, "Geçersiz VIP tipi"],
  [/Ge[^\n]*ersiz tier/g, "Geçersiz tier"],
  [/VIP sat[^\n]*n al[^\n]*namad[^\n]*/g, "VIP satın alınamadı"],
  [/VIP durumu al[^\n]*namad[^\n]*/g, "VIP durumu alınamadı"],
  [/[^\n]*statistikler al[^\n]*namad[^\n]*/g, "İstatistikler alınamadı"],
  [/VIP ayarlanamad[^\n]*/g, "VIP ayarlanamadı"],
  [/VIP kald[^\n]*r[^\n]*ld[^\n]*/g, "VIP kaldırıldı"],
  // Inline messages
  [/Yetersiz coin \(e[^\n]*zamanl[^\n]*[^\n]*lem\)/g, "Yetersiz coin (eş zamanlı işlem)"],
  [/VIP sat[^\n]*n al[^\n]*nd[^\n]*\s*\(\$\{days\}\s*g[^\n]*n\)/g, "VIP satın alındı (${days} gün)"],
  [/g[^\n]*n verildi/g, "gün verildi"],
];

for (const [pattern, replacement] of replacements) {
  content = content.replace(pattern, replacement);
}

// Also fix Transaction description
content = content.replace(
  /`\$\{tier\.charAt\(0\)\.toUpperCase\(\) \+ tier\.slice\(1\)\} VIP sat[^\n]*n al[^\n]*nd[^\n]*\s*\(\$\{days\}\s*g[^\n]*n\)`/g,
  "`${tier.charAt(0).toUpperCase() + tier.slice(1)} VIP satın alındı (${days} gün)`"
);

// Fix message responses
content = content.replace(
  /`\$\{tier\} VIP \$\{grantDays\} g[^\n]*n verildi`/g,
  "`${tier} VIP ${grantDays} gün verildi`"
);

fs.writeFileSync(filePath, content, "utf8");
console.log("vipController.js patched successfully");
