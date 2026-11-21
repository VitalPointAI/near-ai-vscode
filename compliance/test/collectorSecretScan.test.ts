// Secret-scan collector (44-07, D-23, D-24): only the scan mode and aggregate
// counts are evidence; finding text and rule details cannot cross this boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { secretScanCollector } from '../src/collectors/secretScan.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'secret-scan');
const NOW = new Date('2026-11-21T12:00:00Z');
const COMMIT = 'b'.repeat(40);

function context(files: Readonly<Record<string, string>> = {}): CollectorContext {
  return { now: NOW, commit: COMMIT, readFile: async (file) => Object.hasOwn(files, file) ? files[file] : readFile(file, 'utf8') };
}

test('a clean scan produces a passing tracked observation with only aggregate counts', async () => {
  const [observation] = await secretScanCollector.collect({ jsonFile: path.join(FIXTURES, 'clean.json') }, context());
  assert.equal(secretScanCollector.id, 'secret-scan');
  assert.equal(secretScanCollector.window, 'head');
  assert.deepEqual(observation, { collector: 'secret-scan', subject: 'tracked', passed: true, collectedAt: NOW.toISOString(), commit: COMMIT, counts: { files: 42, findings: 0 } });
});

test('a finding makes the observation fail while retaining only aggregate counts', async () => {
  const [observation] = await secretScanCollector.collect({ jsonFile: path.join(FIXTURES, 'finding.json') }, context());
  assert.equal(observation.passed, false);
  assert.deepEqual(observation.counts, { files: 42, findings: 1 });
  assert.doesNotMatch(JSON.stringify(observation), /generic-secret|rules|allowlisted/);
});

test('invalid JSON and structurally invalid output are collector errors, never passing evidence', async () => {
  await assert.rejects(secretScanCollector.collect({ jsonFile: '/bad.json' }, context({ '/bad.json': '{ nope' })), /could not read JSON/);
  await assert.rejects(secretScanCollector.collect({ jsonFile: '/wrong.json' }, context({ '/wrong.json': '{"mode":"tracked","files":1,"findings":0,"clean":"yes"}' })), /must contain/);
  await assert.rejects(secretScanCollector.collect({ jsonFile: '' }, context()), /jsonFile/);
});
