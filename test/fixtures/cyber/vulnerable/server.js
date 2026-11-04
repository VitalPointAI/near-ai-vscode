'use strict';

// A deliberately weak target: every issue the defensive probes must find is seeded here on purpose.
// Plain Node, zero dependencies, binds 127.0.0.1 on OS-chosen ports, and prints one READY line so a
// test can learn the ports. Nothing here is a real credential.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const TLS_DIR = path.join(__dirname, '..', 'certs', 'vulnerable');
const APP_VERSION = '1.2.3';

const INDEX = '<html><body><h1>Fixture target</h1><p>Seeded weakness, do not deploy.</p></body></html>';

// Seeded weakness: the login check interpolates the submitted username into its comparison string,
// so `' OR '1'='1` is accepted. A string comparison stands in for the missing parameterisation,
// which keeps the fixture dependency-free while behaving like the injected query it models.
function loginVulnerable(username, password) {
  const predicate = `username = '${username}' AND password = '${password}'`;
  const injected = /'\s*OR\s*'?1'?\s*=\s*'?1/i.test(predicate);
  return injected ? 'ok' : username === 'admin' && password === 'admin' ? 'ok' : 'denied';
}

function headers(extra) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    Server: `fixture/${APP_VERSION}`,
    ...extra
  };
}

const app = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/login') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const verdict = loginVulnerable(form.get('username') || '', form.get('password') || '');
      response.writeHead(verdict === 'ok' ? 200 : 401, headers());
      response.end(JSON.stringify({ result: verdict }));
    });
    return;
  }
  if (url.pathname === '/robots.txt') {
    response.writeHead(200, { 'Content-Type': 'text/plain', Server: `fixture/${APP_VERSION}` });
    response.end('User-agent: *\nDisallow: /backup/\nDisallow: /admin\n');
    return;
  }
  if (url.pathname === '/sitemap.xml') {
    response.writeHead(200, { 'Content-Type': 'application/xml', Server: `fixture/${APP_VERSION}` });
    response.end('<?xml version="1.0"?><urlset><url><loc>/</loc></url><url><loc>/backup/</loc></url></urlset>');
    return;
  }
  if (url.pathname === '/backup/') {
    response.writeHead(200, { 'Content-Type': 'text/plain', Server: `fixture/${APP_VERSION}` });
    response.end('db-export.sql\nseeded backup listing, no index page\n');
    return;
  }
  if (url.pathname === '/health') {
    response.writeHead(200, headers());
    response.end('ok');
    return;
  }
  response.writeHead(200, headers());
  response.end(INDEX);
});

const tls = https.createServer(
  { key: fs.readFileSync(path.join(TLS_DIR, 'server.key')), cert: fs.readFileSync(path.join(TLS_DIR, 'server.pem')) },
  (request, response) => {
    response.writeHead(200, headers());
    response.end(INDEX);
  }
);

tls.listen(0, '127.0.0.1', () => {
  app.listen(0, '127.0.0.1', () => {
    console.log(`READY ${app.address().port} ${tls.address().port}`);
  });
});

for (const server of [app, tls]) server.on('error', (error) => { console.error(error.message); process.exit(1); });
