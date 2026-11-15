// Local test endpoint on the HOST: 127.0.0.1 only. Logs what actually arrives.
const http = require('http'); const fs = require('fs');
const log = process.argv[2];
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const rec = { t: new Date().toISOString(), method: req.method, url: req.url, authorization: req.headers['authorization'] || null, body };
    fs.appendFileSync(log, JSON.stringify(rec) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url }));
  });
}).listen(18555, '127.0.0.1', () => console.log('echo server on 127.0.0.1:18555'));
