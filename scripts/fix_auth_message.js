// Add 'message' key alongside 'error' key in authController.js error responses
// Pattern: { success: false, error: "TEXT" } → { success: false, message: "TEXT", error: "TEXT" }
const fs = require('fs');

function addMessageKey(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const result = [];
  let count = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.replace(/\r$/, '').trim();
    
    // Check if this line is: error: "SOME TEXT"   (or error: "SOME TEXT",)
    // And the PREVIOUS non-empty line is: success: false,
    // And we haven't already seen a message: line between success: and error:
    if (trimmed.match(/^error:\s*"[^"]*",?$/)) {
      // Look back for the success: false line
      let foundMessage = false;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prevTrimmed = result[j] ? result[j].replace(/\r$/, '').trim() : '';
        if (prevTrimmed.startsWith('message:')) {
          foundMessage = true;
          break;
        }
        if (prevTrimmed.startsWith('success:')) break;
      }
      
      if (!foundMessage) {
        // Extract the error text
        const match = trimmed.match(/^error:\s*"([^"]*)"/);
        if (match) {
          // Get the same indentation as the error line
          const indent = line.match(/^(\s*)/)[1];
          // Insert message line before the error line
          result.push(indent + 'message: "' + match[1] + '",');
          count++;
        }
      }
    }
    
    result.push(line);
  }
  
  fs.writeFileSync(filePath, result.join('\n'), 'utf8');
  console.log(filePath + ': added ' + count + ' message keys');
}

addMessageKey('src/controllers/authController.js');
