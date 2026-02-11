const https = require('https');
const API_KEY = 'rnd_WTO2T42DOVy405KacHuKGsrGNBSA';
const OWNER_ID = 'tea-d5k20remcj7s738momsg';

const body = JSON.stringify({
  type: 'web_service',
  name: 'eyra-admin',
  ownerId: OWNER_ID,
  repo: 'https://github.com/aydincvkn-maker/eyra-kontrol',
  autoDeploy: 'yes',
  branch: 'main',
  serviceDetails: {
    region: 'frankfurt',
    plan: 'free',
    envSpecificDetails: {
      buildCommand: 'npm install && npm run build',
      startCommand: 'npm start',
    },
    runtime: 'node',
    envVars: [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'NEXT_PUBLIC_API_URL', value: 'https://eyra-backend.onrender.com' },
      { key: 'NEXT_PUBLIC_API_BASE', value: 'https://eyra-backend.onrender.com/api' },
    ],
  },
});

const req = https.request({
  hostname: 'api.render.com',
  path: '/v1/services',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const data = JSON.parse(d);
      console.log(JSON.stringify(data, null, 2));
      if (data.service) {
        const url = data.service.serviceDetails?.url || `https://${data.service.slug}.onrender.com`;
        console.log('\n=== ADMIN PANEL URL:', url, '===');
      }
    } catch { console.log(d); }
  });
});
req.on('error', console.error);
req.write(body);
req.end();
