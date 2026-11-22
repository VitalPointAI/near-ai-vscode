import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeManifest, verifyManifest } from '../src/manifest.ts';
import { runBundle } from '../src/bundle.ts';

const commit = 'a'.repeat(40);
const folder = () => mkdtempSync(path.join(tmpdir(), 'near-ai-bundle-'));

// The bundle layer is deliberately tested through the public manifest contract: a
// reader must reject additions, edits, removals and symlinks rather than trusting
// a folder merely because a manifest is present.
test('bundle manifest functions are available', async () => {
  const manifest = await import('../src/manifest.ts');
  assert.equal(typeof manifest.writeManifest, 'function');
  assert.equal(typeof manifest.verifyManifest, 'function');
});

test('manifest lists relative sorted SHA-256 entries and verifies', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'b.txt'), 'second'); writeFileSync(path.join(dir, 'a.txt'), 'first');
  const manifest = writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  assert.deepEqual(manifest.files.map((entry) => entry.path), ['a.txt', 'b.txt']);
  assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && !entry.path.includes('..')));
  assert.deepEqual(verifyManifest(dir), { ok: true, errors: [] });
});

test('manifest names a changed file', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'evidence.json'), '{}'); writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  writeFileSync(path.join(dir, 'evidence.json'), '{ }');
  assert.match(verifyManifest(dir).errors.join('\n'), /evidence\.json: changed/);
});

test('manifest rejects added and missing files', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'a'), 'a'); writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  writeFileSync(path.join(dir, 'new'), 'n'); assert.match(verifyManifest(dir).errors.join('\n'), /new: unexpected/);
  unlinkSync(path.join(dir, 'new')); unlinkSync(path.join(dir, 'a')); assert.match(verifyManifest(dir).errors.join('\n'), /a: missing/);
});

test('manifest rejects symlinks rather than following them', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'a'), 'a'); writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  unlinkSync(path.join(dir, 'a')); symlinkSync('/etc/hosts', path.join(dir, 'a'));
  assert.match(verifyManifest(dir).errors.join('\n'), /symlink.*a|a.*symlink/);
});

test('runBundle writes the evidence layout even when no collector was selected', async () => {
  const dir = folder(); const result = await runBundle({ repository: 'owner/repo', commit, kind: 'main', repoRoot: process.cwd(), collectors: {} }, dir, { now: new Date('2026-11-21T00:00:00.000Z') });
  assert.equal(result.collectors.length, 12);
  for (const file of ['observations.json', 'test-rows.json', 'collectors.json', 'dashboard/dashboard.json', 'manifest.json']) assert.ok(readFileSync(path.join(dir, file), 'utf8').length > 0, file);
  assert.equal(verifyManifest(dir).ok, true);
});

test('runBundle refuses to publish a dashboard with unsupported compliance claims', async () => {
  const dir = folder();
  await assert.rejects(runBundle({
    repository: 'owner/repo', commit, kind: 'main', repoRoot: process.cwd(), collectors: {},
    dashboard: { levels: [{ id: 'fixture', title: 'ITAR certified', controls: [], components: [] }] },
  }, dir), /dashboard copy lint failed/);
  assert.equal(verifyManifest(dir).ok, false);
});
