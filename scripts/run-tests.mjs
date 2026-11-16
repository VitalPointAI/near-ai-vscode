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

// 0.4.25: the tests run in a process group of their own (not on Windows, which has none), so that after an error of the runner's own it can tell
// when every test process has exited. `node --test` exits on SIGTERM before the test files it started have, so waiting for it alone is not enough.
const grouped = process.platform !== 'win32';
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', detached: grouped, env: { ...process.env, TMPDIR: runDir, TEMP: runDir, TMP: runDir } });
/** How long the runner waits, after an error of its own, for the tests to exit before it stops them with SIGKILL and removes the folder. */
const CHILD_EXIT_WAIT_MS = 10_000;
const signalTests = (signal) => {
  try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
};
const testsRunning = () => {
  if (!grouped) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
let failed = false;
process.on('uncaughtException', (error) => {
  console.error(error);
  if (failed) return;
  failed = true;
  // The tests stop too, so nothing is left writing into a folder that is about to go. 0.4.25: the folder was removed right after the signal, while
  // the tests could still be writing into it (a test cleaning up on SIGTERM brought it back, and it was left behind). It is now removed once every
  // test process has exited, or after CHILD_EXIT_WAIT_MS, when they are stopped with SIGKILL first.
  signalTests('SIGTERM');
  const deadline = Date.now() + CHILD_EXIT_WAIT_MS;
  const timer = setInterval(() => {
    if (testsRunning() && Date.now() < deadline) return;
    clearInterval(timer);
    if (testsRunning()) signalTests('SIGKILL');
    cleanup();
    process.exit(1);
  }, 50);
});
// A signal to the runner goes to every test process, as it did when they shared the runner's process group (Ctrl+C, `timeout`).
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => signalTests(signal));
child.on('error', (error) => { console.error(error); cleanup(); process.exit(1); });
child.on('exit', (code, signal) => {
  // After an error of the runner's own, the wait above removes the folder once the rest of the tests have exited too.
  if (failed) return;
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
