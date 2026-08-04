// egress-selftest.js
// Verifies EGRESS_PROXY routing and the direct-fallback path.
// Reports the observed egress IP so it is obvious which route was taken.
//
//   docker run --rm --network <net> -e EGRESS_PROXY=socks5h://host:1055 \
//     shopify-catalog-test node egress-selftest.js

const https = require('https');
const egress = require('./egress');

function get(host, path, agent) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'GET', agent,
      ...egress.TLS_OPTIONS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; catalog-watcher/1.0)', 'Accept': '*/*' } },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' on ' + host));
          resolve(body);
        });
      });
    req.on('error', err => { const e = new Error('Fetch error on ' + host + ': ' + err.message); e.egressCode = err.code; reject(e); });
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out on ' + host)));
    req.end();
  });
}

(async () => {
  console.log('config: ' + egress.describe());

  try {
    const ip = await egress.viaEgress(a => get('api.ipify.org', '/', a), 'ip-check');
    console.log('egress IP: ' + ip.trim());
  } catch (e) {
    console.log('egress IP: FAILED (' + e.message + ')');
  }

  for (const host of ['hiproof.com', 'tipxy.com', 'remedyliquor.com', 'www.dramcellars.com']) {
    try {
      const body = await egress.viaEgress(a => get(host, '/products.json?limit=1', a), host);
      const n = (JSON.parse(body).products || []).length;
      console.log('  ' + host.padEnd(22) + ' OK (' + n + ' product)');
    } catch (e) {
      console.log('  ' + host.padEnd(22) + ' FAIL: ' + e.message);
    }
  }

  console.log('stats: ' + JSON.stringify(egress.stats()));
})();
