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
