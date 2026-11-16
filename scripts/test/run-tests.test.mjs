// The test runner wrapper (scripts/run-tests.mjs) keeps every temporary folder the tests make in one folder of its own and removes it when it ends. #46
// review: it removed that folder only when the test run finished normally, not when the wrapper itself failed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
