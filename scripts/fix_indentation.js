// Fix indentation damage from automated script in authController.js and vipController.js
const fs = require('fs');

function fixIndentation(filePath) {
  let code = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  
  // Pattern: The broken indentation looks like:
  //       return res.status(NNN).json({
  //       success: false,
  //       message: "...",
  //       error: "...",
  //     });
  //
  // Should be:
  //       return res.status(NNN).json({
  //         success: false,
  //         message: "...",
  //         error: "...",
  //       });

  // Match the broken pattern and fix it
  const pattern = /(\s*(?:return )?res\.status\(\d+\)\.json\(\{)\n(\s*)(success: (?:true|false),)\n(\s*)(message: "[^"]*",)\n(\s*)(error: "[^"]*",?)\n(\s*)\}\)/g;
  
  code = code.replace(pattern, (match, jsonLine, sp1, successLine, sp2, messageLine, sp3, errorLine, sp4) => {
    // Get the base indent from the json line
    const baseIndentMatch = jsonLine.match(/^(\s*)/);
    const baseIndent = baseIndentMatch ? baseIndentMatch[1] : '    ';
    const innerIndent = baseIndent + '  ';
    
    count++;
    return `${jsonLine}\n${innerIndent}${successLine}\n${innerIndent}${messageLine}\n${innerIndent}${errorLine}\n${baseIndent}})`;
  });
  
  fs.writeFileSync(filePath, code, 'utf8');
  console.log(`${filePath}: fixed ${count} indentation blocks`);
}

fixIndentation('src/controllers/authController.js');
fixIndentation('src/controllers/vipController.js');
