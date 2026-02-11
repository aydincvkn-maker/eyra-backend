const https = require('https');
const API_KEY = 'rnd_WTO2T42DOVy405KacHuKGsrGNBSA';

const req = https.get('https://api.render.com/v1/services?limit=20', {
  headers: { 'Authorization': 'Bearer ' + API_KEY, 'Accept': 'application/json' }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const services = JSON.parse(d);
    console.log('=== RENDER SERVICES ===\n');
    for (const item of services) {
      const s = item.service;
      const url = s.serviceDetails?.url || `https://${s.slug}.onrender.com`;
      console.log(`Name: ${s.name}`);
      console.log(`ID: ${s.id}`);
      console.log(`URL: ${url}`);
      console.log(`Status: ${s.suspended}`);
      console.log(`Repo: ${s.repo}`);
      console.log(`Type: ${s.type}`);
      console.log('---');
    }
  });
});
req.on('error', console.error);
