// patch_vip_errors.js
const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "src", "controllers", "vipController.js");
let content = fs.readFileSync(filePath, "utf8");

// Map of garbled → correct strings (using Buffer to handle the actual bytes)
// Strategy: replace garbled multi-byte sequences with correct UTF-8 text
// The garbled chars represent latin-1 re-encoded sequences

// We'll do simple indexOf-based replacements to be safe
function replaceAll(str, find, replace) {
  return str.split(find).join(replace);
}

// Error messages (these appear as garbled in the file)
// Read the raw bytes to find patterns
const bad = Buffer.from(content, "utf8").toString("utf8"); // same as content

// The file has mojibake. Let's identify by what appears in the content:
// Using actual string values that appear when file is read as UTF-8

// Approach: replace each garbled sequence precisely
// From read_file output we know these exact strings appear in file:

const fixes = [];

// Scan file for lines with encoding issues and fix them line by line
const lines = content.split("\n");
const fixedLines = lines.map((line) => {
  // Skip lines that look already correct (contain proper Turkish)
  if (line.includes("alınamadı") || line.includes("bulunamadı") || 
      line.includes("satın") || line.includes("kaldırıldı")) {
    return line;
  }
  
  // Fix: al─▒namad─▒ → alınamadı
  // The sequence ─▒ in UTF-8 is [E2 94 80 C2 B1] → should be ı [C4 B1]
  // But let's try direct replacement using what read_file returns
  
  return line;
});

// Actually let's use a different approach: 
// read the file as latin1, fix the chars, write as utf8
const rawContent = fs.readFileSync(filePath);
// The file might have double-encoded sequences
// Let's detect and fix by pattern matching on the actual content string

// From read_file, garbled sequences:
// "al─▒namad─▒" → "alınamadı" 
// "Kullan─▒c─▒" → "Kullanıcı"
// "Ge├ğersiz" → "Geçersiz"  (├ğ → Ç)
// "sat─▒n al─▒nd─▒" → "satın alındı"
// "sat─▒n al─▒namad─▒" → "satın alınamadı"
// "kald─▒r─▒ld─▒" → "kaldırıldı"
// "kald─▒r" → "kaldır" (in comment)
// "ayarlanamad─▒" → "ayarlanamadı"
// "─░statistikler" → "İstatistikler"
// "g├╜n" or "g├╭n" → "gün"
// "d├╜┼şm├╜┼ş" → "düşmüş"
// "e┼ş zamanl─▒ i┼şlem" → "eş zamanlı işlem"
// "zamanl─▒" → "zamanlı"

// Since the exact bytes are tricky, let's use a Node.js approach:
// Read the file, detect the encoding issue patterns using regex on the actual chars

// The ─▒ sequence in the garbled text: when read_file shows "─▒" it's U+2500 U+25B2... 
// Wait no. Let me check what ─ and ▒ are:
// ─ = U+2500 (BOX DRAWINGS LIGHT HORIZONTAL)
// ▒ = U+2592 (MEDIUM SHADE)

// So "al─▒namad─▒" in UTF-8 bytes:
// a=61, l=6C, ─=E2 94 80, ▒=E2 96 92, n=6E, a=61, m=61, d=64, ─=E2 94 80, ▒=E2 96 92

// But the CORRECT "alınamadı" is:
// a=61, l=6C, ı=C4 B1, n=6E, a=61, m=61, d=64, ı=C4 B1

// So [E2 94 80 E2 96 92] (4 bytes = 2 box chars) → should be [C4 B1] (2 bytes = ı)

// Similarly for other replacements. Let me just do Buffer-level replacements:

function bufReplace(buf, fromStr, toStr) {
  const from = Buffer.from(fromStr, "utf8");
  const to = Buffer.from(toStr, "utf8");
  let result = buf;
  let idx = result.indexOf(from);
  while (idx !== -1) {
    result = Buffer.concat([result.slice(0, idx), to, result.slice(idx + from.length)]);
    idx = result.indexOf(from, idx + to.length);
  }
  return result;
}

let buf = fs.readFileSync(filePath);

// Garbled char → correct char mappings (UTF-8 bytes)
// ─▒ (U+2500 U+25B2 — wait, ▒ is U+2592) → ı (U+0131)
// But wait, ▒ = U+2592 and ─ = U+2500
// Let me check if ▒ is actually U+00B2 or U+2592...
// From the PowerShell output: "─▒" where ─ looks like a dash and ▒ is shade
// UTF-8 for U+2500 = E2 94 80, UTF-8 for U+2592 = E2 96 92
// UTF-8 for ı (U+0131) = C4 B1

// The garbled sequence "─▒" represents ı:
buf = bufReplace(buf, "\u2500\u2592", "ı"); // ─▒ → ı  
// But also check ─▒ where ▒ might be different
// Actually PowerShell shows ▒ which could be different code point

// Let me try a different approach - just try the string-level replacement
// since we know exactly what read_file shows

let str = buf.toString("utf8");

// Common garbled patterns → correct Turkish
const strFixes = [
  ["al─▒namad─▒", "alınamadı"],
  ["bulunamad─▒", "bulunamadı"],
  ["Kullan─▒c─▒", "Kullanıcı"],
  ["sat─▒n al─▒nd─▒", "satın alındı"],
  ["sat─▒n al─▒namad─▒", "satın alınamadı"],
  ["kald─▒r─▒ld─▒", "kaldırıldı"],
  ["kald─▒r─▒", "kaldırı"],
  ["kald─▒r", "kaldır"],
  ["ayarlanamad─▒", "ayarlanamadı"],
  ["durumu al─▒namad─▒", "durumu alınamadı"],
  ["─░statistikler", "İstatistikler"],
  ["─░statistik", "İstatistik"],
  ["zamanl─▒", "zamanlı"],
  ["e┼ş", "eş"],
  ["i┼şlem", "işlem"],
  ["┼ş", "ş"],
  ["d├╜┼şm├╜┼ş", "düşmüş"],
  ["d├╭┼şm├╭┼ş", "düşmüş"],
  ["g├╜n", "gün"],
  ["g├╭n", "gün"],
  ["G├╜n", "Gün"],
  ["G├╭n", "Gün"],
  ["├ğersiz", "çersiz"],
  ["Ge├ğ", "Geç"],
  ["ge├ğ", "geç"],
];

for (const [from, to] of strFixes) {
  while (str.includes(from)) {
    str = str.split(from).join(to);
  }
}

// Fix remaining patterns that may be left
// "Ge├ğersiz" → "Geçersiz" (handle the ├ğ → ç case)
// ├ = U+251C, ğ = U+011F → Ç (U+00C7) or ç (U+00E7) depending on context

fs.writeFileSync(filePath, str, "utf8");
console.log("Done. Check results:");
// Print lines with potential remaining issues
str.split("\n").forEach((line, i) => {
  if (/[├╜╝╭╛┼─▒░]/.test(line) || /[┼─]/.test(line)) {
    console.log(`Line ${i+1}: ${line.trim()}`);
  }
});
