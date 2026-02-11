const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const doReq = (u) => {
      https.get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doReq(res.headers.location);
        }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      }).on('error', reject);
    };
    doReq(url);
  });
}

async function main() {
  const raw = await fetch('https://api-docs.render.com/openapi/6140fb3daeae351056086186');
  const spec = JSON.parse(raw);
  const schema = spec.paths['/services'].post.requestBody.content['application/json'].schema;
  
  // Look for web_service related schemas
  const allOf = schema.allOf || [];
  console.log('Top schema keys:', Object.keys(schema));
  console.log(JSON.stringify(schema, null, 2).substring(0, 5000));
}

main().catch(console.error);
