#!/usr/bin/env node
// Runs `node --test` with every temporary folder the tests make kept in one folder of its own, and removes that folder when the run ends.
//
// Many tests make a workspace with mkdtemp(os.tmpdir()) and do not remove it; on 2026-11-14 tens of thousands of `near-ai-*` folders filled the
// inodes of /tmp and every later test failed with ENOSPC. Pointing TMPDIR (which os.tmpdir() honours) at a per-run folder cleans up after all of
// them at once, including tests written later, instead of relying on each test's own `finally`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runDir = mkdtempSync(path.join(tmpdir(), 'near-ai-test-run-'));
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { rmSync(runDir, { recursive: true, force: true, maxRetries: 3 }); } catch (error) { console.error(`Could not remove ${runDir}: ${error.message}`); }
};
// #46 review: the folder is also removed when this script ends any other way (an exception of its own, or process.exit from anywhere), not only when
// the test run finishes normally. `exit` handlers run synchronously, which rmSync is.
process.on('exit', cleanup);

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, TMPDIR: runDir, TEMP: runDir, TMP: runDir } });
process.on('uncaughtException', (error) => {
  console.error(error);
  // The tests stop too, so nothing is left writing into a folder that is about to go.
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  cleanup();
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error); cleanup(); process.exit(1); });
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
