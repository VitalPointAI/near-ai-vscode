import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../..', import.meta.url);
const script = new URL('../scripts/compliance-refresh.mjs', import.meta.url);
const fixture = new URL('../../compliance/test/fixtures/dashboard/dashboard.json', import.meta.url);
const digest = (value) => createHash('sha256').update(value).digest('hex');
function bundle(files = { 'dashboard/dashboard.json': readFileSync(fixture) }) {
  const dir = mkdtempSync(join(tmpdir(), 'near-ai-bundle-'));
  for (const [name, content] of Object.entries(files)) { const target = join(dir, name); mkdirSync(new URL('.', `file://${target}`).pathname, { recursive: true }); writeFileSync(target, content); }
  const manifest = { schemaVersion: 1, createdAt: '2026-11-21T11:00:00Z', commit: 'a'.repeat(40), files: Object.entries(files).map(([path, content]) => ({ path, sha256: digest(content), bytes: Buffer.byteLength(content) })) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
function site() { const dir = mkdtempSync(join(tmpdir(), 'near-ai-docs-site-')); mkdirSync(join(dir, 'build'), { recursive: true }); return dir; }
function refresh(from, to) { return spawnSync(process.execPath, [script.pathname, '--from-dir', from, '--site-dir', to], { encoding: 'utf8' }); }

test('refreshes a verified bundle into static and build', () => {
  const dir = site(); const result = refresh(bundle(), dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'static/compliance/refresh.json'))).manifest, 'verified');
  assert.equal(readFileSync(join(dir, 'static/compliance/dashboard.json'), 'utf8'), readFileSync(join(dir, 'build/compliance/dashboard.json'), 'utf8'));
});
test('refuses a changed byte before it writes', () => {
  const source = bundle(); writeFileSync(join(source, 'dashboard/dashboard.json'), '{}'); const dir = site();
  assert.notEqual(refresh(source, dir).status, 0); assert.throws(() => readFileSync(join(dir, 'static/compliance/dashboard.json')));
});
test('refuses extra files before it writes', () => {
  const source = bundle(); writeFileSync(join(source, 'extra.txt'), 'no'); const dir = site();
  assert.notEqual(refresh(source, dir).status, 0); assert.throws(() => readFileSync(join(dir, 'static/compliance/dashboard.json')));
});
test('refuses paths outside the manifest root', async () => {
  const { verifyBundleDir } = await import(script.href); const source = bundle(); const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'))); manifest.files[0].path = '../dashboard.json'; writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyBundleDir(source));
});
test('preserves the previous site on a failed refresh', () => {
  const dir = site(); const good = bundle(); assert.equal(refresh(good, dir).status, 0); const before = readFileSync(join(dir, 'static/compliance/dashboard.json'), 'utf8');
  const bad = bundle(); writeFileSync(join(bad, 'unexpected.json'), '{}'); assert.notEqual(refresh(bad, dir).status, 0); assert.equal(readFileSync(join(dir, 'static/compliance/dashboard.json'), 'utf8'), before);
});
test('refresh selects a main run with an unexpired artifact and verifies its commit', () => {
  const source = bundle();
  const dir = site();
  const bin = mkdtempSync(join(tmpdir(), 'near-ai-refresh-gh-'));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { cpSync } = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args[1] === 'list') {
  assert.equal(option('--branch'), 'main');
  const ci = option('--workflow') === 'ci.yml';
  assert.equal(option('--event'), ci ? 'push' : 'schedule');
  console.log(JSON.stringify([{ databaseId: ci ? 2 : 3, createdAt: ci ? '2026-11-21' : '2026-11-22', headSha: process.env.RUN_HEAD }]));
} else if (args[0] === 'api') {
  const expired = args[1].includes('/3/');
  console.log(JSON.stringify({ artifacts: [{ name: 'compliance-bundle', expired }] }));
} else {
  assert.equal(args[1], 'download');
  assert.equal(args[2], '2');
  cpSync(process.env.RUN_BUNDLE, option('--dir'), { recursive: true });
}
`, { mode: 0o755 });
  const refreshFromGithub = (head) => spawnSync(process.execPath, [script.pathname, '--site-dir', dir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_HEAD: head, RUN_BUNDLE: source },
  });
  const rejected = refreshFromGithub('b'.repeat(40));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Bundle commit does not match/);
  assert.throws(() => readFileSync(join(dir, 'build/compliance/dashboard.json')));
  const accepted = refreshFromGithub('a'.repeat(40));
  assert.equal(accepted.status, 0, accepted.stderr);
  const metadata = JSON.parse(readFileSync(join(dir, 'build/compliance/refresh.json')));
  assert.equal(metadata.source, 'GitHub run 2');
});
