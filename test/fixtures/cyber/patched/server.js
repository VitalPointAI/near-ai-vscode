'use strict';

// The clean twin of test/fixtures/cyber/vulnerable: same routes, every seeded weakness fixed.
// A defensive scan of this service must report none of the vulnerable fixture's check ids.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const TLS_DIR = path.join(__dirname, '..', 'certs', 'patched');

const INDEX = '<html><body><h1>Fixture target</h1><p>Hardened twin.</p></body></html>';

// The patched login compares the submitted values against the stored credentials exactly, so the
// injection payload is simply wrong input.
function loginPatched(username, password) {
  const known = { admin: 'admin', operator: 'operator-password' };
  return Object.hasOwn(known, username) && known[username] === password ? 'ok' : 'denied';
}

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  Server: 'fixture'
};

const app = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/login') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const verdict = loginPatched(form.get('username') || '', form.get('password') || '');
      response.writeHead(verdict === 'ok' ? 200 : 401, SECURITY_HEADERS);
      response.end(JSON.stringify({ result: verdict }));
    });
    return;
  }
  if (url.pathname === '/robots.txt') {
    response.writeHead(200, { 'Content-Type': 'text/plain', Server: 'fixture' });
    response.end('User-agent: *\nAllow: /\n');
    return;
  }
  if (url.pathname === '/sitemap.xml') {
    response.writeHead(200, { 'Content-Type': 'application/xml', Server: 'fixture' });
    response.end('<?xml version="1.0"?><urlset><url><loc>/</loc></url></urlset>');
    return;
  }
  if (url.pathname === '/health') {
    response.writeHead(200, SECURITY_HEADERS);
    response.end('ok');
    return;
  }
  response.writeHead(200, SECURITY_HEADERS);
  response.end(INDEX);
});

const tls = https.createServer(
  { key: fs.readFileSync(path.join(TLS_DIR, 'server.key')), cert: fs.readFileSync(path.join(TLS_DIR, 'server.pem')) },
  (request, response) => {
    response.writeHead(200, SECURITY_HEADERS);
    response.end(INDEX);
  }
);

tls.listen(0, '127.0.0.1', () => {
  app.listen(0, '127.0.0.1', () => {
    console.log(`READY ${app.address().port} ${tls.address().port}`);
  });
});

for (const server of [app, tls]) server.on('error', (error) => { console.error(error.message); process.exit(1); });
