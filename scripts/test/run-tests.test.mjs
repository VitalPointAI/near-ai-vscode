// The test runner wrapper (scripts/run-tests.mjs) keeps every temporary folder the tests make in one folder of its own and removes it when it ends. #46
// review: it removed that folder only when the test run finished normally, not when the wrapper itself failed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'run-tests.mjs');
/** The environment for a nested run: without NODE_TEST_CONTEXT, which would make the nested `node --test` report to this run instead of running. */
const env = (extra) => { const copy = { ...process.env, ...extra }; delete copy.NODE_TEST_CONTEXT; return copy; };

/** A folder with a test file that records the temporary folder it was given, then stays busy for a while. */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-tests-fixture-'));
  const mark = path.join(dir, 'tmpdir.txt');
  const file = path.join(dir, 'records.test.mjs');
  writeFileSync(file, `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('records', async () => { writeFileSync(process.env.MARK, process.env.TMPDIR); await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS || 0))); });\n`);
  return { dir, mark, file };
}

test('the run folder is removed when the tests finish', () => {
  const { mark, file } = fixture();
  const result = spawnSync(process.execPath, [runner, file], { env: env({ MARK: mark }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const runDir = readFileSync(mark, 'utf8');
  assert.match(path.basename(runDir), /^near-ai-test-run-/);
  assert.equal(existsSync(runDir), false);
});

test('the run folder is removed, and the tests stopped, when the runner itself throws', () => {
  const { dir, mark, file } = fixture();
  // Loaded into the runner only (a spawned child does not inherit --import): once the tests have started, the runner throws.
  const preload = path.join(dir, 'throw.mjs');
  writeFileSync(preload, `import { existsSync } from 'node:fs';\nconst timer = setInterval(() => { if (existsSync(process.env.MARK)) { clearInterval(timer); throw new Error('runner failed'); } }, 20);\n`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, runner, file], { env: env({ MARK: mark, HOLD_MS: '20000' }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runner failed/);
  assert.ok(Date.now() - started < 15_000, 'it did not wait for the tests to finish');
  const runDir = readFileSync(mark, 'utf8');
  assert.equal(existsSync(runDir), false, `${runDir} is left behind`);
});

// 0.4.25: when the runner threw, it removed the run folder right after signalling the tests, while they could still be writing into it (a test that
// cleans up on SIGTERM, or one between two writes), so the folder could come back and be left behind. It now waits, for a bounded time, for the
// tests to exit before removing it.
test('when the runner throws, the run folder is removed only after the tests have exited', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-tests-fixture-'));
  const mark = path.join(dir, 'tmpdir.txt');
  const file = path.join(dir, 'late.test.mjs');
  // On SIGTERM the test takes a moment to finish, then writes one last file into its temporary folder, as a test cleaning up after itself would.
  writeFileSync(file, `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nimport { test } from 'node:test';\ntest('late', async () => {\n  process.on('SIGTERM', () => setTimeout(() => { mkdirSync(process.env.TMPDIR, { recursive: true }); writeFileSync(path.join(process.env.TMPDIR, 'late.txt'), 'x'); writeFileSync(process.env.MARK + '.done', ''); process.exit(0); }, 500));\n  writeFileSync(process.env.MARK, process.env.TMPDIR);\n  await new Promise((resolve) => setTimeout(resolve, 20000));\n});\n`);
  const preload = path.join(dir, 'throw.mjs');
  writeFileSync(preload, `import { existsSync } from 'node:fs';\nconst timer = setInterval(() => { if (existsSync(process.env.MARK)) { clearInterval(timer); throw new Error('runner failed'); } }, 20);\n`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, runner, file], { env: env({ MARK: mark }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runner failed/);
  assert.ok(Date.now() - started < 15_000, 'it did not wait for the tests to finish on their own');
  // The test's last write may land after the runner has exited, so the check waits (bounded) until the test says it is done.
  const until = Date.now() + 10_000;
  while (!existsSync(`${mark}.done`) && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 50)']);
  assert.ok(existsSync(`${mark}.done`), 'the test finished its last write');
  const runDir = readFileSync(mark, 'utf8');
  assert.equal(existsSync(runDir), false, `${runDir} is left behind`);
});

// Phase 44 (D-22, D-46): with NEAR_AI_TEST_REPORT set, the runner also writes one JSON line per leaf test (the per-test evidence the compliance
// collectors read); unset, nothing changes.

/** A temporary folder holding the given files (path relative to the folder, forward slashes, to content). */
function fixtureFiles(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-tests-report-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

/** One test of each status: passed, skipped with a reason, todo, a failing test inside a suite, and an `it.skip` beside it. */
const MIXED = [
  "import { describe, it, test } from 'node:test';",
  "test('passes', () => {});",
  "test('skipped with a reason', { skip: 'not now' }, () => {});",
  "test('still to write', { todo: true }, () => {});",
  "describe('outer', () => {",
  "  it('inner fails', () => { throw new Error('expected failure'); });",
  "  it.skip('skipped inside', () => {});",
  '});',
  '',
].join('\n');

/** A run of the runner in `cwd` with the given files, with NEAR_AI_TEST_REPORT exactly as given (never inherited from this run). */
const runReport = (cwd, files, report, extra = {}) => {
  const runEnv = env(report === undefined ? extra : { ...extra, NEAR_AI_TEST_REPORT: report });
  if (report === undefined) delete runEnv.NEAR_AI_TEST_REPORT;
  return spawnSync(process.execPath, [runner, ...files], { cwd, env: runEnv, encoding: 'utf8', timeout: 60_000 });
};
const rows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
/** The console output without the timings, which differ between two runs. */
const steady = (text) => text.replace(/\(\d+(\.\d+)?ms\)/g, '(ms)').replace(/duration_ms [\d.]+/g, 'duration_ms N');

test('NEAR_AI_TEST_REPORT: one row per leaf test with its file, suite path, name, status, skip reason and duration', () => {
  const dir = fixtureFiles({ 'sub/mixed.test.mjs': MIXED });
  const result = runReport(dir, ['sub/mixed.test.mjs'], 'report.ndjson');
  assert.equal(result.status, 1, 'a failing test still fails the run');
  const report = rows(path.join(dir, 'report.ndjson'));
  assert.deepEqual(report.map(({ path: suites, name, status, skip }) => ({ path: suites, name, status, skip })), [
    { path: [], name: 'passes', status: 'passed', skip: null },
    { path: [], name: 'skipped with a reason', status: 'skipped', skip: 'not now' },
    { path: [], name: 'still to write', status: 'todo', skip: null },
    { path: ['outer'], name: 'inner fails', status: 'failed', skip: null },
    { path: ['outer'], name: 'skipped inside', status: 'skipped', skip: null },
  ]);
  for (const row of report) {
    assert.deepEqual(Object.keys(row).sort(), ['file', 'ms', 'name', 'path', 'skip', 'status']);
    assert.equal(row.file, 'sub/mixed.test.mjs', 'relative to the working directory, forward slashes');
    assert.equal(typeof row.ms, 'number');
    assert.ok(row.ms >= 0);
  }
});

test('NEAR_AI_TEST_REPORT: a TypeScript CommonJS test emits its literal leaf name', () => {
  // Root tests are compiled with `esModuleInterop` and therefore call the
  // default imported node:test function from CommonJS output.
  const compiled = [
    '"use strict";',
    'var __importDefault = (mod) => (mod && mod.__esModule) ? mod : { default: mod };',
    'const node_test_1 = __importDefault(require("node:test"));',
    '(0, node_test_1.default)("compiled leaf is reported", () => {});',
    '',
  ].join('\n');
  const dir = fixtureFiles({ 'dist/test/compiled.test.js': compiled });
  const result = runReport(dir, ['dist/test/compiled.test.js'], 'report.ndjson');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(rows(path.join(dir, 'report.ndjson')).map(({ file, name, status }) => ({ file, name, status })), [
    { file: 'dist/test/compiled.test.js', name: 'compiled leaf is reported', status: 'passed' },
  ]);
});

test('NEAR_AI_TEST_REPORT: the exit code and the console output are the same as without it', () => {
  const dir = fixtureFiles({ 'mixed.test.mjs': MIXED });
  const plain = runReport(dir, ['mixed.test.mjs'], undefined);
  const reported = runReport(dir, ['mixed.test.mjs'], 'report.ndjson');
  assert.equal(plain.status, 1);
  assert.equal(reported.status, plain.status);
  assert.match(reported.stdout, /✔ passes/);
  assert.match(reported.stdout, /✖ inner fails/);
  assert.match(reported.stdout, /ℹ tests 5/);
  assert.equal(steady(reported.stdout), steady(plain.stdout));
  assert.ok(existsSync(path.join(dir, 'report.ndjson')));
});

test('NEAR_AI_TEST_REPORT unset: no report is written and the run is as before', () => {
  const dir = fixtureFiles({ 'mixed.test.mjs': MIXED });
  const result = runReport(dir, ['mixed.test.mjs'], undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ℹ tests 5/);
  assert.match(result.stdout, /ℹ fail 1/);
  assert.deepEqual(readdirSync(dir), ['mixed.test.mjs'], 'nothing else appeared in the working directory');
  // An empty value is the same as unset.
  const empty = runReport(dir, ['mixed.test.mjs'], '');
  assert.equal(empty.status, 1);
  assert.deepEqual(readdirSync(dir), ['mixed.test.mjs']);
});

test('NEAR_AI_TEST_REPORT: a nested run that a test starts never writes into the outer report (pitfall 10)', () => {
  const dir = fixtureFiles({
    // The inner name is longer than the outer one, so a nested write into the same file cannot hide under the outer run's own line.
    'inner.test.mjs': "import { test } from 'node:test';\ntest('inner passes, with a name much longer than the outer test has', () => {});\n",
    'outer.test.mjs': [
      "import assert from 'node:assert/strict';",
      "import { spawnSync } from 'node:child_process';",
      "import { test } from 'node:test';",
      "test('outer starts a nested run', () => {",
      '  const nested = { ...process.env }; delete nested.NODE_TEST_CONTEXT;',
      "  const result = spawnSync(process.execPath, [process.env.RUNNER, 'inner.test.mjs'], { env: nested, encoding: 'utf8' });",
      '  assert.equal(result.status, 0, result.stderr);',
      '  assert.match(result.stdout, /inner passes/);',
      '});',
      '',
    ].join('\n'),
  });
  const result = runReport(dir, ['outer.test.mjs'], 'report.ndjson', { RUNNER: runner });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(rows(path.join(dir, 'report.ndjson')).map(({ file, name, status }) => ({ file, name, status })), [
    { file: 'outer.test.mjs', name: 'outer starts a nested run', status: 'passed' },
  ]);
});

test('NEAR_AI_TEST_REPORT: a report folder that does not exist yet is created', () => {
  const dir = fixtureFiles({ 'one.test.mjs': "import { test } from 'node:test';\ntest('one passes', () => {});\n" });
  const result = runReport(dir, ['one.test.mjs'], path.join('out', 'deeper', 'report.ndjson'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(rows(path.join(dir, 'out', 'deeper', 'report.ndjson')).map(({ name, status }) => ({ name, status })), [
    { name: 'one passes', status: 'passed' },
  ]);
});

test('NEAR_AI_TEST_REPORT: suite paths stay right with deeper suites and several files in one run (absolute report path)', () => {
  const deep = (label) => [
    "import { describe, it } from 'node:test';",
    `describe('${label} one', () => {`,
    `  describe('${label} two', () => { it('${label} deep', async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); });`,
    `  it('${label} shallow', () => {});`,
    '});',
    `it('${label} top', () => {});`,
    '',
  ].join('\n');
  const dir = fixtureFiles({ 'a.test.mjs': deep('a'), 'b.test.mjs': deep('b') });
  const report = path.join(dir, 'report.ndjson');
  const result = runReport(dir, ['a.test.mjs', 'b.test.mjs'], report);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const got = rows(report).map(({ file, path: suites, name }) => ({ file, path: suites, name }));
  const want = ['a', 'b'].flatMap((label) => [
    { file: `${label}.test.mjs`, path: [`${label} one`, `${label} two`], name: `${label} deep` },
    { file: `${label}.test.mjs`, path: [`${label} one`], name: `${label} shallow` },
    { file: `${label}.test.mjs`, path: [], name: `${label} top` },
  ]);
  const order = (list) => [...list].sort((x, y) => `${x.file} ${x.name}`.localeCompare(`${y.file} ${y.name}`));
  assert.deepEqual(order(got), order(want));
});
