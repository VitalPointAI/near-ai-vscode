#!/usr/bin/env node
// The image's HEALTHCHECK: GET /healthz on the workbench's own port, 3 s timeout. Exit 0 when it answers 200, 1 otherwise.
// It asks 127.0.0.1 unless the workbench listens on one specific other address (a wildcard bind answers on loopback too).
import http from 'node:http';

const configured = process.env.STERLING_LISTEN_HOST?.trim() || '127.0.0.1';
const host = ['0.0.0.0', '::', '[::]'].includes(configured) ? '127.0.0.1' : configured === 'localhost' ? '127.0.0.1' : configured;

const request = http.get({ host, port: 3000, path: '/healthz', timeout: 3000 }, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(1));
