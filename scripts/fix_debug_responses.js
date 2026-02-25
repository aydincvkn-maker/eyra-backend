// Fix debugRoutes dynamic error patterns
const fs = require('fs');
let code = fs.readFileSync('src/routes/debugRoutes.js', 'utf8');

// Fix bare { error: err.message } → { success: false, message: err.message, error: err.message }
code = code.replace(
  /res\.status\((\d+)\)\.json\(\{ error: err\.message \}\)/g,
  'res.status($1).json({ success: false, message: err.message, error: err.message })'
);

// Fix { success: false, error: error.message } → add message key
code = code.replace(
  /res\.status\((\d+)\)\.json\(\{ success: false, error: error\.message \}\)/g,
  'res.status($1).json({ success: false, message: error.message, error: error.message })'
);

fs.writeFileSync('src/routes/debugRoutes.js', code, 'utf8');
console.log('debugRoutes fixed');
