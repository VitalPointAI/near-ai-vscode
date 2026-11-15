// Run INSIDE the sandbox with node.
const net = require('net');
async function f(label, url, opts = {}) {
  try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    const body = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
    console.log(`${label}: HTTP ${r.status} :: ${body}`);
  } catch (e) { console.log(`${label}: ERROR ${e.cause?.code || ''} ${e.cause?.message || e.message}`.slice(0, 200)); }
}
function tcp(label, host, port) { return new Promise(res => {
  const s = net.connect({ host, port, timeout: 10000 }, () => { console.log(`${label}: CONNECTED`); s.destroy(); res(); });
  s.on('error', e => { console.log(`${label}: ERROR ${e.code} ${e.message}`.slice(0, 160)); res(); });
  s.on('timeout', () => { console.log(`${label}: TIMEOUT`); s.destroy(); res(); });
}); }
(async () => {
  console.log('env HTTPS_PROXY=', process.env.HTTPS_PROXY || process.env.https_proxy || '(unset)');
  await f('E1 allowed GET registry.npmjs.org/left-pad', 'https://registry.npmjs.org/left-pad');
  await f('E2 POST to allowed host (policy read-only)', 'https://registry.npmjs.org/-/v1/login', { method: 'POST', body: '{}' });
  await f('E3 GET example.com (not in policy)', 'https://example.com/');
  await f('E4 GET github.com (not in policy)', 'https://github.com/');
  await tcp('E5 raw TCP 1.1.1.1:443 (IP, not in policy)', '1.1.1.1', 443);
  await f('E6 cloud metadata 169.254.169.254', 'http://169.254.169.254/latest/meta-data/');
  await tcp('E7 host loopback 127.0.0.1:8080', '127.0.0.1', 8080);
})();
