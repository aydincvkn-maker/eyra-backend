// patch_usercontroller_follow.js
const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "src", "controllers", "userController.js");
let str = fs.readFileSync(filePath, "utf8");

const fixes = [
  // Follow notification title/emoji
  ["Yeni TakipÃ§i! ğŸ'‹", "Yeni Takipçi! 👋"],
  ["New Follower! ğŸ'‹", "New Follower! 👋"],
  // Follow notification body
  ["seni takip etmeye baÅŸladÄ±", "seni takip etmeye başladı"],
  // Also check for other garbled patterns in this file
  ["âœ… ", "✅ "],
  ["âœ…", "✅"],
  ["âš ï¸", "⚠️"],
  ["Ã§i", "çi"],
  ["ÃŸ", "ß"],
  ["Ä±", "ı"],
  ["ÅŸ", "ş"],
  ["Å\u009f", "ş"],
];

let count = 0;
for (const [from, to] of fixes) {
  if (str.includes(from)) {
    str = str.split(from).join(to);
    count++;
    console.log(`Fixed: "${from.substring(0, 40)}" → "${to.substring(0, 40)}"`);
  }
}

if (count > 0) {
  fs.writeFileSync(filePath, str, "utf8");
  console.log(`\nSaved with ${count} fix(es).`);
} else {
  console.log("Nothing to fix.");
}
