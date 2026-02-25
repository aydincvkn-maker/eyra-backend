// Batch-replace bare {message} error responses with sendError calls in userController
const fs = require('fs');
let code = fs.readFileSync('src/controllers/userController.js', 'utf8');

// Add import if not already present
if (!code.includes("sendError")) {
  code = code.replace(
    '// src/controllers/userController.js',
    '// src/controllers/userController.js\nconst { sendError } = require("../utils/response");'
  );
}

let count = 0;
const lines = code.split('\n');
const result = [];

for (const line of lines) {
  let newLine = line;
  
  // Match: res.status(NNN).json({ message: "TEXT" }) — bare, no success key
  const bareMessagePattern = /res\.status\((\d+)\)\.json\(\{\s*message:\s*["']([^"']+)["']\s*\}\)/;
  const match = newLine.match(bareMessagePattern);
  
  if (match && !newLine.includes('success:')) {
    const status = match[1];
    const msg = match[2];
    newLine = newLine.replace(bareMessagePattern, `sendError(res, ${status}, "${msg}")`);
    count++;
  }
  
  result.push(newLine);
}

code = result.join('\n');
fs.writeFileSync('src/controllers/userController.js', code, 'utf8');
console.log('Replaced ' + count + ' bare message responses in userController');
