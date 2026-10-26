import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unifiedDiff } from '../agent/diff';
import { matchesGlob } from '../agent/glob';
import { resolveInWorkspace } from '../agent/workspace';

test('workspace paths resolve inside the root and refuse escapes, including through symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-ws-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'near-ai-outside-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(outside, 'secret.txt'), 'x');
  await symlink(outside, path.join(root, 'link'));
  const real = await resolveInWorkspace(root, '.');
  assert.equal(await resolveInWorkspace(root, 'src/new-file.ts'), path.join(real, 'src', 'new-file.ts'));
  await assert.rejects(() => resolveInWorkspace(root, '../escape.txt'), /outside the workspace/);
  await assert.rejects(() => resolveInWorkspace(root, '/etc/passwd'), /outside the workspace/);
  await assert.rejects(() => resolveInWorkspace(root, 'link/secret.txt'), /outside the workspace/);
  await assert.rejects(() => resolveInWorkspace(root, 'link/not-yet.txt'), /outside the workspace/);
});

test('unified diff shows changed lines with context and correct hunk ranges', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n';
  const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n') + '\n';
  assert.equal(unifiedDiff(before, after, 'x.txt'), [
    '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,8 +1,9 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ' h', '+i'
  ].join('\n'));
  assert.equal(unifiedDiff('same', 'same', 'x'), '');
  assert.match(unifiedDiff('', 'new\n', 'n.txt'), /@@ -0,0 \+1,1 @@\n\+new/);
});

test('glob patterns match paths the way the tools expect', () => {
  assert.equal(matchesGlob('**/*.ts', 'src/agent/loop.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'loop.ts'), true);
  assert.equal(matchesGlob('src/*.ts', 'src/agent/loop.ts'), false);
  assert.equal(matchesGlob('*.{ts,js}', 'media/chat/chat.js'), true);
  assert.equal(matchesGlob('src/**/test/*.test.ts', 'src/test/a.test.ts'), true);
  assert.equal(matchesGlob('file?.md', 'file1.md'), true);
});

test('shell session keeps cd and variables between commands, reports exit codes, and survives a timeout', async () => {
  const { ShellSession } = await import('../agent/shell');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-shell-'));
  await mkdir(path.join(root, 'sub'));
  const shell = new ShellSession(root);
  try {
    const first = await shell.run('cd sub && export GREETING=hi && echo "in $(basename "$PWD")"');
    assert.equal(first.exitCode, 0);
    assert.equal(first.output.trim(), 'in sub');
    const second = await shell.run('echo "$GREETING from $(basename "$PWD")"; echo oops >&2; exit_code_test() { return 3; }; exit_code_test');
    assert.equal(second.output.trim(), 'hi from sub\noops');
    assert.equal(second.exitCode, 3);
    const reading = await shell.run('cat; echo after');
    assert.equal(reading.output.trim(), 'after', 'stdin is /dev/null, so cat cannot swallow the control lines');
    const slow = await shell.run('sleep 5', 1_000);
    assert.equal(slow.timedOut, true);
    assert.match(slow.output, /timed out/);
    const after = await shell.run('echo alive');
    assert.equal(after.output.trim(), 'alive');
  } finally {
    shell.dispose();
  }
});

test('background shells run independently and report new output on each read', async () => {
  const { ShellSession } = await import('../agent/shell');
  const shell = new ShellSession(await mkdtemp(path.join(tmpdir(), 'near-ai-bg-')));
  try {
    const id = shell.startBackground('echo start; sleep 0.3; echo end');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(shell.readBackground(id).output.trim(), 'start');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const later = shell.readBackground(id);
    assert.equal(later.output.trim(), 'end');
    assert.equal(later.running, false);
    assert.equal(later.exitCode, 0);
  } finally {
    shell.dispose();
  }
});

test('checkpoints restore edited files and delete created ones', async () => {
  const { RunCheckpoints } = await import('../agent/checkpoints');
  const { readFile, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-ckpt-'));
  const store = await mkdtemp(path.join(tmpdir(), 'near-ai-ckpt-store-'));
  await writeFile(path.join(root, 'a.txt'), 'original');
  const checkpoints = new RunCheckpoints('run-1', store);
  await checkpoints.capture(path.join(root, 'a.txt'));
  await writeFile(path.join(root, 'a.txt'), 'changed once');
  await checkpoints.capture(path.join(root, 'a.txt'));
  await writeFile(path.join(root, 'a.txt'), 'changed twice');
  await checkpoints.capture(path.join(root, 'b.txt'));
  await writeFile(path.join(root, 'b.txt'), 'created');
  const reloaded = await RunCheckpoints.load('run-1', store);
  assert.ok(reloaded, 'snapshots survive a reload');
  await reloaded.revert();
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['a.txt']);
});

test('permissions: reads always run, writes follow the policy, commands follow deny, grants, allow, then policy', async () => {
  const { decidePermission, DEFAULT_RULES, RunGrants } = await import('../agent/permissions');
  const risky: import('../domain/policy').ActionPolicy = { mode: 'approve-risky', emergencyStop: false };
  const grants = new RunGrants();
  const decide = (capability: Parameters<typeof decidePermission>[0], command?: string, policy = risky) => decidePermission(capability, command, policy, DEFAULT_RULES, grants).decision;
  assert.equal(decide('read'), 'allow');
  assert.equal(decide('workspaceWrite'), 'ask');
  assert.equal(decide('workspaceWrite', undefined, { mode: 'mostly-autonomous', emergencyStop: false }), 'allow');
  assert.equal(decide('shell', 'git status'), 'allow');
  assert.equal(decide('shell', 'git status --short'), 'allow');
  assert.equal(decide('shell', 'git statusx'), 'ask', 'prefix must end at a word boundary');
  assert.equal(decide('shell', 'ls; rm -rf build'), 'ask', 'compound commands are never auto-allowed');
  assert.equal(decide('shell', 'ls $(cat secrets)'), 'ask');
  assert.equal(decide('shell', 'npm test'), 'ask');
  grants.commands.add('npm test');
  assert.equal(decide('shell', 'npm   test'), 'allow', 'a run grant matches the normalized command');
  assert.equal(decide('shell', 'git push --force origin main', { mode: 'fully-autonomous', emergencyStop: false }), 'deny');
  grants.edits = true;
  assert.equal(decide('workspaceWrite'), 'allow');
  assert.equal(decide('read', undefined, { mode: 'fully-autonomous', emergencyStop: true }), 'deny');
});
