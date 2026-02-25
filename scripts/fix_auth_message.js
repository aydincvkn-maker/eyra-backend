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
    // And a nearby PREVIOUS line in the ORIGINAL array is: success: false,
    // And we haven't already seen a message: line between success: and error:
    if (trimmed.match(/^error:\s*"[^"]*",?$/)) {
      // Look back in the ORIGINAL lines array (not result) to avoid index shift issues
      let foundMessage = false;
      let foundSuccess = false;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prevTrimmed = lines[j].replace(/\r$/, '').trim();
        if (prevTrimmed.startsWith('message:')) {
          foundMessage = true;
          break;
        }
        if (prevTrimmed.startsWith('success:')) {
          foundSuccess = true;
          break;
        }
      }
      
      if (foundSuccess && !foundMessage) {
        // Extract the error text
        const match = trimmed.match(/^error:\s*"([^"]*)"/);
        if (match) {
          // Get the same indentation as the error line
          const indent = line.match(/^(\s*)/)[1];
          // Insert message line before the error line
          result.push(indent + 'message: "' + match[1] + '",\r');
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
