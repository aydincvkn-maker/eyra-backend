#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

const files = [
  "jobs/cleanup.js",
  "jobs/presenceSync.js",
  "jobs/salaryCron.js",
  "models/User.js",
];

let total = 0;
for (const rel of files) {
  const fp = path.join(SRC, rel);
  if (!fs.existsSync(fp)) {
    console.log("SKIP (not found): " + rel);
    continue;
  }
  let content = fs.readFileSync(fp, "utf8");
  const logC = (content.match(/console\.log\(/g) || []).length;
  const errC = (content.match(/console\.error\(/g) || []).length;
  const wrnC = (content.match(/console\.warn\(/g) || []).length;
  const t = logC + errC + wrnC;
  if (t === 0) {
    console.log("SKIP (0 hits): " + rel);
    continue;
  }

  content = content.replace(/console\.log\(/g, "logger.info(");
  content = content.replace(/console\.error\(/g, "logger.error(");
  content = content.replace(/console\.warn\(/g, "logger.warn(");

  const hasImport =
    content.includes('require("../utils/logger")') ||
    content.includes("require('../utils/logger')") ||
    content.includes('require("../../utils/logger")') ||
    content.includes("require('../../utils/logger')");

  if (!hasImport) {
    const lines = content.split("\n");
    let lastReq = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("require(")) lastReq = i;
      if (lastReq >= 0 && lines[i].trim() === "") break;
    }
    const imp = 'const { logger } = require("../../utils/logger");';
    if (lastReq >= 0) lines.splice(lastReq + 1, 0, imp);
    else lines.unshift(imp);
    content = lines.join("\n");
  }

  fs.writeFileSync(fp, content, "utf8");
  total += t;
  console.log(`  OK ${rel}: ${logC} log, ${errC} error, ${wrnC} warn`);
}
console.log("Total: " + total + " replacements");
