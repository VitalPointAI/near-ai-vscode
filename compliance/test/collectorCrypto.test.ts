// Crypto collector (44-07, D-09, D-24): rows in the inventory become evidence
// by algorithm id, while basis text and document content never leave the collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cryptoCollector } from '../src/collectors/crypto.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'crypto', 'crypto-inventory.md');
const ROOT = '/fixture-checkout';
const INVENTORY = path.join(ROOT, 'docs/security/crypto-inventory.md');
const NOW = new Date('2026-11-21T00:00:00.000Z');
const COMMIT = 'd'.repeat(40);

async function fixture(): Promise<string> { return readFile(FIXTURE, 'utf8'); }
function context(text: string): CollectorContext { return { now: NOW, commit: COMMIT, readFile: async (file) => {
  if (file === INVENTORY) return text;
  throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
} }; }

test('one observation is emitted for each inventory row with its review date', async () => {
  const observations = await cryptoCollector.collect({ repoRoot: ROOT }, context(await fixture()));
  assert.equal(cryptoCollector.id, 'crypto');
  assert.equal(cryptoCollector.window, 'document');
  assert.deepEqual(observations.map((observation) => [observation.subject, observation.passed, observation.collectedAt]), [
    ['aes-256-gcm', true, '2026-10-22T00:00:00.000Z'], ['ed25519', true, '2026-10-22T00:00:00.000Z'], ['x25519', false, '2026-10-22T00:00:00.000Z']
  ]);
});

test('observations retain only ids, time, pass or fail, and commit', async () => {
  const observations = await cryptoCollector.collect({ repoRoot: ROOT }, context(await fixture()));
  for (const observation of observations) {
    assert.deepEqual(Object.keys(observation).sort(), ['collectedAt', 'collector', 'commit', 'passed', 'subject']);
    assert.equal(observation.commit, COMMIT);
    assert.doesNotMatch(JSON.stringify(observation), /fixture encryption|fixture signatures|Basis/);
  }
});

test('an unknown ITSP standing is a named collector error, never a passing row', async () => {
  const unknown = (await fixture()).replace('listed with conditions', 'maybe listed');
  await assert.rejects(cryptoCollector.collect({ repoRoot: ROOT }, context(unknown)), /unknown ITSP standing in row \d+: maybe listed/);
});

test('a missing review statement or malformed headers are collector errors', async () => {
  const text = await fixture();
  await assert.rejects(cryptoCollector.collect({ repoRoot: ROOT }, context(text.replace('Last reviewed: 2026-10-22\n\n', ''))), /Last reviewed/);
  await assert.rejects(cryptoCollector.collect({ repoRoot: ROOT }, context(text.replace('Where used', 'Use'))), /headers/);
});
