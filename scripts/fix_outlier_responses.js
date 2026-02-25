// Fix remaining outlier files for unified error responses
const fs = require('fs');

function fixFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP: ${filePath} not found`);
    return;
  }
  
  let code = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  
  // Add sendError import if not present
  if (!code.includes('sendError')) {
    // Try to add after last require statement
    const lines = code.split('\n');
    let lastRequireIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('require(')) lastRequireIdx = i;
      if (lines[i].trim() === '' && lastRequireIdx >= 0 && i > lastRequireIdx + 2) break;
    }
    if (lastRequireIdx >= 0) {
      lines.splice(lastRequireIdx + 1, 0, 'const { sendError } = require("../utils/response");');
      code = lines.join('\n');
    }
  }
  
  // Fix bare { message: "..." } patterns (no success key)
  const lines2 = code.split('\n');
  const result = [];
  
  for (const line of lines2) {
    let newLine = line;
    
    const bareMessagePattern = /res\.status\((\d+)\)\.json\(\{\s*message:\s*["']([^"']+)["']\s*\}\)/;
    const match = newLine.match(bareMessagePattern);
    
    if (match && !newLine.includes('success:') && !newLine.includes('ok:')) {
      const status = match[1];
      const msg = match[2];
      newLine = newLine.replace(bareMessagePattern, `sendError(res, ${status}, "${msg}")`);
      count++;
    }
    
    result.push(newLine);
  }
  
  code = result.join('\n');
  fs.writeFileSync(filePath, code, 'utf8');
  console.log(`${description}: ${count} replacements`);
}

// Fix authController: { success: false, error: "..." } → add message key alongside error
function fixAuthStyle(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP: ${filePath} not found`);
    return;
  }
  
  let code = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  
  // Pattern: { success: false, error: "TEXT" } → { success: false, message: "TEXT", error: "TEXT" }
  // Also handles multiline variants
  const pattern = /\{\s*\n?\s*success:\s*false,\s*\n?\s*error:\s*"([^"]+)"\s*,?\s*\n?\s*\}/g;
  
  code = code.replace(pattern, (match, msg) => {
    // Already has message key?
    if (match.includes('message:')) return match;
    count++;
    return `{\n      success: false,\n      message: "${msg}",\n      error: "${msg}",\n    }`;
  });
  
  fs.writeFileSync(filePath, code, 'utf8');
  console.log(`${description}: ${count} error→message additions`);
}

// Fix paymentController .send() → .json()
function fixSendToJson(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP: ${filePath} not found`);
    return;
  }
  
  let code = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  
  // Pattern: res.status(NNN).send("TEXT") → sendError(res, NNN, "TEXT")  
  const pattern = /res\.status\((\d+)\)\.send\("([^"]+)"\)/g;
  code = code.replace(pattern, (match, status, msg) => {
    count++;
    return `sendError(res, ${status}, "${msg}")`;
  });
  
  // Add import if needed and if replacements were made
  if (count > 0 && !code.includes('sendError')) {
    const lines = code.split('\n');
    let lastRequireIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('require(')) lastRequireIdx = i;
    }
    if (lastRequireIdx >= 0) {
      lines.splice(lastRequireIdx + 1, 0, 'const { sendError } = require("../utils/response");');
      code = lines.join('\n');
    }
  }
  
  fs.writeFileSync(filePath, code, 'utf8');
  console.log(`paymentController .send→.json: ${count} replacements`);
}

// Execute fixes
fixFile('src/routes/callRoutes.js', 'callRoutes');
fixFile('src/routes/debugRoutes.js', 'debugRoutes');
fixFile('src/routes/reportRoutes.js', 'reportRoutes');
fixAuthStyle('src/controllers/authController.js', 'authController');
fixAuthStyle('src/controllers/vipController.js', 'vipController');
fixSendToJson('src/controllers/paymentController.js');

console.log('\nDone!');
