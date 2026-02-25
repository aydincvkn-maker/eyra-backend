// Batch-replace bare {message} error responses with sendError calls
const fs = require('fs');
let code = fs.readFileSync('src/controllers/chatController.js', 'utf8');

// Replace bare { message: "..." } patterns (no success key)
// But NOT { success: false, message: "..." } (these are already correct)
let count = 0;

// Replace patterns line by line for precision
const lines = code.split('\n');
const result = [];

for (const line of lines) {
  let newLine = line;
  
  // Match: res.status(NNN).json({ message: "TEXT" })
  // But NOT: { success: false, message: ... } or { success: true, message: ... }
  const bareMessagePattern = /res\.status\((\d+)\)\.json\(\{\s*message:\s*["']([^"']+)["']\s*\}\)/;
  const match = newLine.match(bareMessagePattern);
  
  if (match && !newLine.includes('success:')) {
    const status = match[1];
    const msg = match[2];
    const hasReturn = newLine.includes('return ');
    
    const replacement = `sendError(res, ${status}, "${msg}")`;
    newLine = newLine.replace(bareMessagePattern, replacement);
    
    count++;
  }
  
  result.push(newLine);
}

code = result.join('\n');
fs.writeFileSync('src/controllers/chatController.js', code, 'utf8');
console.log('Replaced ' + count + ' bare message responses');
