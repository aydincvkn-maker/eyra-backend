#!/usr/bin/env node
/**
 * Bulk migration: console.log/error/warn → logger.info/error/warn
 * Only touches files in src/services, src/controllers, src/middleware, src/routes
 * Skips files that are part of the logger itself.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const DIRS = ["services", "controllers", "middleware", "routes"];
const LOGGER_IMPORT = 'const { logger } = require("../utils/logger");';
const LOGGER_IMPORT_ALT = "const { logger } = require('../utils/logger');";

// Files to skip (they legitimately use console)
const SKIP_FILES = new Set(["logger.js"]);

let totalReplacements = 0;
let filesModified = 0;

for (const dir of DIRS) {
  const dirPath = path.join(SRC, dir);
  if (!fs.existsSync(dirPath)) continue;

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    const filePath = path.join(dirPath, file);
    let content = fs.readFileSync(filePath, "utf8");
    const original = content;

    // Count replacements
    const logCount = (content.match(/console\.log\(/g) || []).length;
    const errorCount = (content.match(/console\.error\(/g) || []).length;
    const warnCount = (content.match(/console\.warn\(/g) || []).length;
    const total = logCount + errorCount + warnCount;

    if (total === 0) continue;

    // Replace
    content = content.replace(/console\.log\(/g, "logger.info(");
    content = content.replace(/console\.error\(/g, "logger.error(");
    content = content.replace(/console\.warn\(/g, "logger.warn(");

    // Ensure logger import exists
    const hasLoggerImport =
      content.includes('require("../utils/logger")') ||
      content.includes("require('../utils/logger')") ||
      content.includes('require("../../utils/logger")') ||
      content.includes("require('../../utils/logger')");

    if (!hasLoggerImport) {
      // Find last require() line to insert after
      const lines = content.split("\n");
      let lastRequireIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("require(")) {
          lastRequireIdx = i;
        }
        // Stop after the first blank line after requires
        if (lastRequireIdx >= 0 && lines[i].trim() === "") break;
      }

      if (lastRequireIdx >= 0) {
        lines.splice(lastRequireIdx + 1, 0, LOGGER_IMPORT);
      } else {
        // No requires found, add at top
        lines.unshift(LOGGER_IMPORT);
      }
      content = lines.join("\n");
    }

    if (content !== original) {
      fs.writeFileSync(filePath, content, "utf8");
      totalReplacements += total;
      filesModified++;
      console.log(
        `  ✅ ${dir}/${file}: ${logCount} log, ${errorCount} error, ${warnCount} warn → logger`,
      );
    }
  }
}

console.log(
  `\nDone: ${totalReplacements} replacements across ${filesModified} files`,
);
