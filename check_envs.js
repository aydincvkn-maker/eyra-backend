const https = require('https');
const API_KEY = 'rnd_WTO2T42DOVy405KacHuKGsrGNBSA';

// Check env vars for eyra-admin
const req = https.get('https://api.render.com/v1/services/srv-d66fhgf5r7bs73b6tplg/env-vars', {
  headers: { 'Authorization': 'Bearer ' + API_KEY, 'Accept': 'application/json' }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('=== eyra-admin env vars ===');
    const vars = JSON.parse(d);
    for (const v of vars) {
      console.log(`${v.envVar.key} = ${v.envVar.value}`);
    }
    
    // Now check backend env vars
    const req2 = https.get('https://api.render.com/v1/services/srv-d5kls9uid0rc73aj4rrg/env-vars', {
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Accept': 'application/json' }
    }, (res2) => {
      let d2 = '';
      res2.on('data', c => d2 += c);
      res2.on('end', () => {
        console.log('\n=== eyra-backend env vars ===');
        const vars2 = JSON.parse(d2);
        for (const v of vars2) {
          const val = v.envVar.key.includes('SECRET') || v.envVar.key.includes('PASSWORD') 
            ? '***hidden***' : v.envVar.value;
          console.log(`${v.envVar.key} = ${val}`);
        }
      });
    });
    req2.on('error', console.error);
  });
});
req.on('error', console.error);
