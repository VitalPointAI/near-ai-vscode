// CI collector (44-07, D-23, D-24): the trusted needs result becomes a compact
// observation per listed job; skipped and cancelled jobs are never passing evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CI_OBSERVATION_JOBS, ciCollector } from '../src/collectors/ci.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'ci', 'needs.json');
const NOW = new Date('2026-11-21T12:00:00Z');
const COMMIT = 'a'.repeat(40);
const RUN_URL = 'https://github.com/example/repo/actions/runs/44';

function context(files: Readonly<Record<string, string>> = {}): CollectorContext {
  return { now: NOW, commit: COMMIT, runUrl: RUN_URL, readFile: async (file) => Object.hasOwn(files, file) ? files[file] : readFile(file, 'utf8') };
}

test('collects one result per known CI job plus docs, with only success passing', async () => {
  const observations = await ciCollector.collect({ needsFile: FIXTURE }, context());
  assert.equal(ciCollector.id, 'ci');
  assert.equal(ciCollector.window, 'head');
  assert.deepEqual(observations.map((observation) => [observation.subject, observation.passed]), [
    ['lint', true], ['test', false], ['e2e', false], ['secret-scan', false], ['docs', true]
  ]);
  assert.deepEqual(CI_OBSERVATION_JOBS, ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', 'docs']);
});

test('does not create evidence for a job missing from needs or an unrelated job', async () => {
  const observations = await ciCollector.collect({ needsFile: FIXTURE }, context());
  assert.equal(observations.some((observation) => observation.subject === 'release-content'), false);
  assert.equal(observations.some((observation) => observation.subject === 'unrelated'), false);
});

test('observations retain the run address and commit but no outputs, logs, or counts', async () => {
  const observations = await ciCollector.collect({ needsFile: FIXTURE }, context());
  for (const observation of observations) {
    assert.deepEqual(Object.keys(observation).sort(), ['collectedAt', 'collector', 'commit', 'passed', 'runUrl', 'subject']);
    assert.equal(observation.collectedAt, NOW.toISOString());
    assert.equal(observation.commit, COMMIT);
    assert.equal(observation.runUrl, RUN_URL);
    assert.doesNotMatch(JSON.stringify(observation), /private|never copied|outputs/i);
  }
});

test('refuses an invalid needs document and input without a file name', async () => {
  await assert.rejects(ciCollector.collect({ needsFile: '/bad.json' }, context({ '/bad.json': '[]' })), /needs file/);
  await assert.rejects(ciCollector.collect({ needsFile: '' }, context()), /needsFile/);
});
