// The tests collector (44-07, D-21, D-24): per-test reports from each package become source-path rows and one counts-only observation per package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_REPORT_LINE_BYTES, parseReport, readReport, readReports, testsCollector } from '../src/collectors/tests.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'tests');
const ROOT_REPORT = path.join(TESTS, 'root.ndjson');
const RELAY_REPORT = path.join(TESTS, 'relay.ndjson');
const NOW = new Date('2026-11-21T12:00:00Z');
const COMMIT = 'd'.repeat(40);
const RUN_URL = 'https://github.com/example/repo/actions/runs/1';

const enoent = (file: string): Error => Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: 'ENOENT' });

function context(files: Record<string, string> = {}): CollectorContext {
  return {
    now: NOW,
    commit: COMMIT,
    runUrl: RUN_URL,
    readFile: async (file) => {
      if (Object.hasOwn(files, file)) return files[file];
      if (file.startsWith('/virtual/')) throw enoent(file);
      return readFile(file, 'utf8');
    }
  };
}

const passingRow = (name: string): string => `${JSON.stringify({ file: 'dist/test/ok.test.js', path: [], name, status: 'passed', skip: null, ms: 1 })}\n`;

test('readReport maps the root report to source paths and keeps the reporter fields', async () => {
  const { rows, errors } = await readReport(ROOT_REPORT);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 4);
  assert.deepEqual(new Set(rows.map((row) => row.file)), new Set(['src/test/sample.test.ts']));
  assert.deepEqual(rows.map((row) => row.status), ['passed', 'skipped', 'todo', 'failed']);
  assert.deepEqual(rows[3].path, ['sample suite']);
  assert.equal(rows[1].skip, 'fixture skip');
});

test('readReport with the relay prefix maps dist/test/a.test.js and dist/test/container/b.test.js to the relay sources', async () => {
  const { rows, errors } = await readReport(RELAY_REPORT, 'relay');
  assert.deepEqual(errors, []);
  assert.deepEqual([...new Set(rows.map((row) => row.file))], ['relay/test/a.test.ts', 'relay/test/container/b.test.ts']);
});

test('testsCollector gives one counts-only observation per package, failing when a row failed or the report is missing', async () => {
  const observations = await testsCollector.collect(
    { reports: [{ package: 'root', file: ROOT_REPORT }, { package: 'relay', file: RELAY_REPORT }, { package: 'hub', file: '/virtual/hub.ndjson' }, { package: 'compliance', file: '/virtual/ok.ndjson' }] },
    context({ '/virtual/ok.ndjson': passingRow('one') + passingRow('two') })
  );
  assert.equal(testsCollector.id, 'tests');
  assert.equal(testsCollector.window, 'head');
  assert.deepEqual(observations.map((o) => [o.subject, o.passed]), [['root', false], ['relay', false], ['hub', false], ['compliance', true]]);
  assert.deepEqual(observations[0].counts, { rows: 4, passed: 1, failed: 1, skipped: 1, todo: 1, malformed: 0, missing: 0 });
  assert.deepEqual(observations[1].counts, { rows: 8, passed: 2, failed: 2, skipped: 2, todo: 2, malformed: 0, missing: 0 });
  assert.deepEqual(observations[2].counts, { rows: 0, passed: 0, failed: 0, skipped: 0, todo: 0, malformed: 0, missing: 1 });
  for (const observation of observations) {
    assert.equal(observation.collector, 'tests');
    assert.equal(observation.commit, COMMIT);
    assert.equal(observation.runUrl, RUN_URL);
    assert.equal(observation.collectedAt, NOW.toISOString());
    assert.deepEqual(Object.keys(observation).sort(), ['collectedAt', 'collector', 'commit', 'counts', 'passed', 'runUrl', 'subject']);
    assert.doesNotMatch(JSON.stringify(observation), /sample|fixture skip|dist\/test/, 'no test names, skip text or paths in an observation (D-24)');
  }
});

test('an empty report is not passing evidence', async () => {
  const [observation] = await testsCollector.collect({ reports: [{ package: 'root', file: '/virtual/empty.ndjson' }] }, context({ '/virtual/empty.ndjson': '\n' }));
  assert.equal(observation.passed, false);
  assert.equal(observation.counts?.rows, 0);
});

test('a malformed report line is reported with its line number and does not stop the rest', async () => {
  const text = [
    passingRow('first').trimEnd(),
    '{ not json',
    JSON.stringify({ file: 'dist/test/ok.test.js', path: [], name: 'bad status', status: 'maybe', skip: null, ms: 1 }),
    JSON.stringify({ file: 'dist/test/ok.test.js', path: 'not a list', name: 'bad path', status: 'passed', skip: null, ms: 1 }),
    `"${'x'.repeat(MAX_REPORT_LINE_BYTES)}"`,
    passingRow('last').trimEnd()
  ].join('\n');
  const { rows, errors } = parseReport(text, undefined, 'root report');
  assert.deepEqual(rows.map((row) => row.name), ['first', 'last']);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /^root report line 2: /);
  assert.match(errors[1], /^root report line 3: /);
  assert.match(errors[2], /^root report line 4: /);
  assert.match(errors[3], /^root report line 5: .*longer than/);
  for (const error of errors) assert.doesNotMatch(error, /bad status|bad path|xxxx/, 'an error names the line, never its text');
  const [observation] = await testsCollector.collect({ reports: [{ package: 'root', file: '/virtual/r.ndjson' }] }, context({ '/virtual/r.ndjson': text }));
  assert.equal(observation.passed, false, 'a malformed line is never counted as a pass');
  assert.equal(observation.counts?.malformed, 4);
  assert.equal(observation.counts?.passed, 2);
  const read = await readReports({ reports: [{ package: 'root', file: '/virtual/r.ndjson' }] }, context({ '/virtual/r.ndjson': text }));
  assert.equal(read.rows.length, 2);
  assert.match(read.errors[0], /^root report line 2: /);
});

test('the collector input is checked: a bad package name, a duplicate package or a missing file name is an error', async () => {
  await assert.rejects(testsCollector.collect({ reports: [{ package: '../x', file: ROOT_REPORT }] }, context()), /package/);
  await assert.rejects(testsCollector.collect({ reports: [{ package: 'root', file: ROOT_REPORT }, { package: 'root', file: ROOT_REPORT }] }, context()), /twice/);
  await assert.rejects(testsCollector.collect({ reports: [{ package: 'root', file: '' }] } as never, context()), /file/);
  await assert.rejects(testsCollector.collect({} as never, context()), /reports/);
});

test('the committed report fixtures are what the real runner and reporter write today (make-report.mjs)', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'near-ai-compliance-fixture-'));
  try {
    // The project runner gives this test a temporary directory that it removes after the test.
    // The fixture generator runs that runner again, so let its own scratch/report directories use
    // the OS temporary directory rather than nesting them under the outer runner's cleanup tree.
    const generatorEnv = { ...process.env };
    delete generatorEnv.TMPDIR;
    delete generatorEnv.TEMP;
    delete generatorEnv.TMP;
    // Node marks its test-worker children with this internal variable. Without removing it,
    // the generator's real nested `node --test` run inherits worker semantics and does not
    // initialize the requested reporter destination.
    delete generatorEnv.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [path.join(TESTS, 'make-report.mjs'), out], { encoding: 'utf8', env: generatorEnv });
    assert.equal(run.status, 0, run.stderr);
    for (const name of ['root.ndjson', 'relay.ndjson']) {
      assert.equal(readFileSync(path.join(out, name), 'utf8'), readFileSync(path.join(TESTS, name), 'utf8'), `${name} is out of date: run make-report.mjs`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
