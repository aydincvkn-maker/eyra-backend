// Fix blank lines in authController.js and vipController.js
const fs = require('fs');

function fixFile(filePath) {
  let code = fs.readFileSync(filePath, 'utf8');
  
  let prev = '';
  let iterations = 0;
  while (code !== prev && iterations < 10) {
    prev = code;
    code = code.replace(/(\.json\(\{)\n\n(\s+success:)/g, '$1\n$2');
    code = code.replace(/(success: (?:true|false),)\n\n(\s+message:)/g, '$1\n$2');
    code = code.replace(/(message: "[^"]*",)\n\n(\s+error:)/g, '$1\n$2');
    code = code.replace(/(error: "[^"]*",?)\n\n(\s+\}\))/g, '$1\n$2');
    iterations++;
  }
  
  fs.writeFileSync(filePath, code, 'utf8');
  console.log(filePath + ': cleaned up (' + iterations + ' passes)');
}

fixFile('src/controllers/authController.js');
fixFile('src/controllers/vipController.js');
