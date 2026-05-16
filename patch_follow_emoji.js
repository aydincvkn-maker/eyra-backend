// patch_follow_emoji.js
const fs = require("fs");
const path = require("path");
const filePath = path.join(__dirname, "src", "controllers", "userController.js");
let str = fs.readFileSync(filePath, "utf8");

// Find the garbled emoji (what looks like "ğŸ'‹" is some garbled sequence)
// Let's scan for it
const idx = str.indexOf("Yeni Takip");
if (idx !== -1) {
  // Print hex bytes around that area
  const around = str.substring(idx, idx + 60);
  console.log("Found at idx:", idx);
  console.log("Text:", JSON.stringify(around));
  const buf = Buffer.from(around, "utf8");
  console.log("Hex:", buf.toString("hex"));
}

// Try to replace the garbled emoji with the correct one
// 👋 = U+1F44B = F0 9F 91 8B in UTF-8
const wave = "\uD83D\uDC4B"; // 👋 as JS surrogate pair

// Look for "! " followed by garbled emoji chars in those title lines
// The garbled might show as different chars depending on encoding layer
// Let's just replace the entire title line
str = str.replace(
  /title: "Yeni Takip[^"]*"/,
  'title: "Yeni Takipçi! 👋"'
);
str = str.replace(
  /titleEn: "New Follower![^"]*"/,
  'titleEn: "New Follower! 👋"'
);

fs.writeFileSync(filePath, str, "utf8");
console.log("Done");

// Verify
const verify = fs.readFileSync(filePath, "utf8");
const check = verify.indexOf("Yeni Takip");
if (check !== -1) console.log("Result:", JSON.stringify(verify.substring(check, check + 50)));
