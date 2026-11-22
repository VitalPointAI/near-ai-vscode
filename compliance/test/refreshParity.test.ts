import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBundle } from '../src/bundle.ts';
import { verifyManifest } from '../src/manifest.ts';
import { verifyBundleDir } from '../../docs-site/scripts/compliance-refresh.mjs';

const folder = () => mkdtempSync(path.join(tmpdir(), 'near-ai-parity-'));

test('a bundle written by runBundle passes both bundle readers', async () => {
  const directory = folder();
  await runBundle({ repository: 'owner/repo', commit: 'a'.repeat(40), kind: 'main', repoRoot: process.cwd(), collectors: {} }, directory, { now: new Date('2026-11-21T00:00:00.000Z') });
  assert.equal(verifyManifest(directory).ok, true);
  assert.ok((await verifyBundleDir(directory)).manifest);
});

test('a changed bundle byte fails both bundle readers', async () => {
  const directory = folder();
  await runBundle({ repository: 'owner/repo', commit: 'a'.repeat(40), kind: 'main', repoRoot: process.cwd(), collectors: {} }, directory, { now: new Date('2026-11-21T00:00:00.000Z') });
  writeFileSync(path.join(directory, 'observations.json'), '{}');
  assert.equal(verifyManifest(directory).ok, false);
  await assert.rejects(() => verifyBundleDir(directory));
});
