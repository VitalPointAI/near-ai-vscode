// The git subprocess wrapper: a timed-out git must settle even when a helper it started keeps the output pipes open (CR-01).
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { runGit } from '../team/runGit';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, withinMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < withinMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('a timed-out git settles even when a helper holds its pipes open, and the helper is killed with it', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-rungit-'));
  let helperPid = 0;
  try {
    const pidFile = path.join(dir, 'helper.pid');
    // A stand-in git: it starts a long-lived helper that inherits stdout and stderr, then waits on it, like git-remote-https under a stalled fetch.
    const fake = path.join(dir, 'git');
    writeFileSync(fake, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(fake, 0o755);
    const startedAt = Date.now();
    const result = await runGit(['fetch'], { env: { PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}` }, timeoutMs: 400 });
    const elapsed = Date.now() - startedAt;
    helperPid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.equal(result.code, 124);
    assert.match(result.stderr, /timed out after 400 ms/);
    assert.ok(elapsed < 5_000, `settled from the timer, not from the helper exiting (took ${elapsed} ms)`);
    assert.ok(helperPid > 0);
    assert.equal(await eventually(() => !alive(helperPid), 3_000), true, 'the helper was killed with the git process group');
  } finally {
    if (helperPid > 0) {
      try { process.kill(helperPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a git that finishes in time still reports its exit code and output', async () => {
  const result = await runGit(['--version'], { timeoutMs: 10_000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout.toString('utf8'), /^git version /);
});
