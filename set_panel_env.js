const https = require('https');
const API_KEY = 'rnd_WTO2T42DOVy405KacHuKGsrGNBSA';
const PANEL_ID = 'srv-d66fhgf5r7bs73b6tplg';

const envVars = [
  { key: 'NODE_ENV', value: 'production' },
  { key: 'NEXT_PUBLIC_API_URL', value: 'https://eyra-backend.onrender.com' },
  { key: 'NEXT_PUBLIC_API_BASE', value: 'https://eyra-backend.onrender.com/api' },
];

const body = JSON.stringify(envVars);

const req = https.request({
  hostname: 'api.render.com',
  path: `/v1/services/${PANEL_ID}/env-vars`,
  method: 'PUT',
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
    } catch { console.log(d); }
  });
});
req.on('error', console.error);
req.write(body);
req.end();
