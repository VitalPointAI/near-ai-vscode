#!/usr/bin/env node
// Serves the built documentation site (docs-site/build) on this computer only.
//
// It binds to a loopback address and nothing else: any other host is refused, so the site is never
// reachable from the network. The port is fixed; if it is taken the server stops with an error
// instead of moving to another port, so the address in the docs always works or fails loudly.
// Files are read from disk on every request, so a rebuild shows up without a restart.
//
// Usage: node scripts/serve.mjs [--port 3210] [--host 127.0.0.1] [--dir build]

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sirv = require('sirv');

const here = dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const host = option('host', '127.0.0.1');
const port = Number(option('port', '3210'));
const dir = resolve(here, '..', option('dir', 'build'));

if (!LOOPBACK.has(host)) {
  console.error(`Refusing to bind to ${host}: the docs server only listens on this computer (127.0.0.1, ::1 or localhost).`);
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`Not a usable port: ${option('port', '')}. Pick one from 1024 to 65535.`);
  process.exit(2);
}
if (!existsSync(resolve(dir, 'index.html'))) {
  console.error(`No built site in ${dir}. Build it first: npm run docs:build (from the repository root).`);
  process.exit(3);
}

const serveFiles = sirv(dir, { dev: true, etag: true, dotfiles: false, extensions: ['html'] });
const notFound = resolve(dir, '404.html');

const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end();
    return;
  }
  serveFiles(req, res, () => {
    res.statusCode = 404;
    if (existsSync(notFound)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : readFileSync(notFound));
      return;
    }
    res.end('Not found');
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} on ${host} is already in use. Stop whatever holds it, or pick another port with --port.`);
  } else {
    console.error(`The docs server stopped: ${error.message}`);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Serving ${dir} at http://${host.includes(':') ? `[${host}]` : host}:${port}/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
