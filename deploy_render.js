const https = require('https');

const API_KEY = 'rnd_WTO2T42DOVy405KacHuKGsrGNBSA';
const OWNER_ID = 'tea-d5k20remcj7s738momsg';

function renderAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.render.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // 1. Create Backend Service
  console.log('\n=== Creating eyra-backend ===');
  const backend = await renderAPI('POST', '/services', {
    type: 'web_service',
    name: 'eyra-backend',
    ownerId: OWNER_ID,
    repo: 'https://github.com/aydincvkn-maker/eyra-backend',
    autoDeploy: 'yes',
    branch: 'main',
    runtime: 'node',
    region: 'frankfurt',
    plan: 'free',
    buildCommand: 'npm install',
    startCommand: 'npm start',
    envVars: [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'PORT', value: '5000' },
      { key: 'MONGO_URI', value: 'mongodb+srv://aydincvkn_db_user:A07015007a@cluster0.b0rneyq.mongodb.net/eyra?retryWrites=true&w=majority&appName=Cluster0' },
      { key: 'JWT_SECRET', value: 'eyra_super_secret_key_321' },
      { key: 'CLIENT_ORIGIN', value: '*' },
      { key: 'MOBILE_ORIGIN', value: '*' },
      { key: 'LIVEKIT_URL', value: 'wss://eyra-8at81fjw.livekit.cloud' },
      { key: 'LIVEKIT_API_KEY', value: 'APIJ6Cnro4AHqqQ' },
      { key: 'LIVEKIT_API_SECRET', value: 's9JibGKNgc2BTTsxCmGRewxo2GiDN0KrUinfsGpjT1J' },
      { key: 'FIREBASE_DATABASE_URL', value: 'https://eyra-9cf0d-default-rtdb.europe-west1.firebasedatabase.app' },
      { key: 'GOOGLE_TRANSLATE_API_KEY', value: 'AIzaSyDzBA49NroupMv1JybCKSIj2RsGRyGY7qk' },
    ],
  });
  console.log(JSON.stringify(backend, null, 2));

  const backendUrl = backend?.service?.serviceDetails?.url || `https://${backend?.service?.slug}.onrender.com`;
  console.log('\nBackend URL:', backendUrl);

  // 2. Create Admin Panel Service
  console.log('\n=== Creating eyra-admin ===');
  const panel = await renderAPI('POST', '/services', {
    type: 'web_service',
    name: 'eyra-admin',
    ownerId: OWNER_ID,
    repo: 'https://github.com/aydincvkn-maker/eyra-kontrol',
    autoDeploy: 'yes',
    branch: 'main',
    runtime: 'node',
    region: 'frankfurt',
    plan: 'free',
    buildCommand: 'npm install && npm run build',
    startCommand: 'npm start',
    envVars: [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'NEXT_PUBLIC_API_URL', value: backendUrl },
      { key: 'NEXT_PUBLIC_API_BASE', value: `${backendUrl}/api` },
    ],
  });
  console.log(JSON.stringify(panel, null, 2));

  const panelUrl = panel?.service?.serviceDetails?.url || `https://${panel?.service?.slug}.onrender.com`;
  console.log('\n========================================');
  console.log('Backend URL:', backendUrl);
  console.log('Panel URL:', panelUrl);
  console.log('========================================');
}

main().catch(console.error);
