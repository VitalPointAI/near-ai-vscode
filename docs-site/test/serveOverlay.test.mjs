import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const script = new URL('../scripts/serve.mjs', import.meta.url).pathname;
async function server({ overlay } = {}) { const base = mkdtempSync(join(tmpdir(), 'near-ai-overlay-')); const build = join(base, 'build'); const port = 32000 + Math.floor(Math.random() * 400); mkdirSync(build); writeFileSync(join(build, 'index.html'), '<h1>site</h1>'); const child = spawn(process.execPath, [script, '--port', String(port), '--dir', build], { env: { ...process.env, ...(overlay ? { NEAR_AI_COMPLIANCE_OVERLAY_DIR: overlay } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.stderr.once('data', (data) => reject(new Error(String(data)))); }); return { child, port, close: () => child.kill('SIGTERM') }; }
function overlay(files = { 'answers.json': '{"kind":"organization-overlay","v":1,"organization":"Example","answers":[],"evidence":[],"decisions":[]}' }) { const dir = mkdtempSync(join(tmpdir(), 'near-ai-overlay-files-')); for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content); return dir; }
async function request(instance, path = '/_overlay/index.json', options = {}) { return fetch(`http://127.0.0.1:${instance.port}${path}`, { headers: { Host: `127.0.0.1:${instance.port}`, ...options.headers }, method: options.method }); }

test('serves local overlays with no-store', async (t) => { const instance = await server({ overlay: overlay() }); t.after(instance.close); const response = await request(instance); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).files.length, 1); });
test('refuses a non-loopback Host header', async (t) => { const instance = await server({ overlay: overlay() }); t.after(instance.close); const response = await new Promise((resolve, reject) => { const req = httpRequest({ host: '127.0.0.1', port: instance.port, path: '/_overlay/index.json', headers: { Host: `evil.example:${instance.port}` } }, (value) => { value.resume(); value.on('end', () => resolve(value)); }); req.on('error', reject); req.end(); }); assert.equal(response.statusCode, 403); });
test('has no endpoint without an overlay folder', async (t) => { const instance = await server(); t.after(instance.close); assert.equal((await request(instance)).status, 404); });
test('refuses POST', async (t) => { const instance = await server({ overlay: overlay() }); t.after(instance.close); assert.equal((await request(instance, '/_overlay/index.json', { method: 'POST' })).status, 405); });
test('skips non-json files', async (t) => { const instance = await server({ overlay: overlay({ 'notes.txt': 'private' }) }); t.after(instance.close); assert.equal((await (await request(instance)).json()).files.length, 0); });
test('skips files above one MiB', async (t) => { const instance = await server({ overlay: overlay({ 'large.json': 'x'.repeat(1024 * 1024 + 1) }) }); t.after(instance.close); assert.equal((await (await request(instance)).json()).files.length, 0); });
test('skips symlinks', async (t) => { const dir = overlay(); const target = join(dir, 'answers.json'); symlinkSync(target, join(dir, 'linked.json')); const instance = await server({ overlay: dir }); t.after(instance.close); assert.equal((await (await request(instance)).json()).files.length, 1); });
test('caps output at sixty-four files', async (t) => { const files = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`${i}.json`, '{}'])); const instance = await server({ overlay: overlay(files) }); t.after(instance.close); assert.equal((await (await request(instance)).json()).files.length, 64); });
