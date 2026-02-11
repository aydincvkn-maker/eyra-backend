const https = require('https');
const API_KEY = 'rnd_WTO2T42DOVy405KacHuKGsrGNBSA';

function triggerDeploy(serviceId, serviceName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = https.request({
      hostname: 'api.render.com',
      path: `/v1/services/${serviceId}/deploys`,
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
        console.log(`${serviceName} deploy status: ${res.statusCode}`);
        try {
          const data = JSON.parse(d);
          console.log(`Deploy ID: ${data.id}, Status: ${data.status}`);
        } catch { console.log(d); }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // Trigger backend deploy
  await triggerDeploy('srv-d5kls9uid0rc73aj4rrg', 'eyra-backend');
  // Trigger panel deploy
  await triggerDeploy('srv-d66fhgf5r7bs73b6tplg', 'eyra-admin');
}

main().catch(console.error);
