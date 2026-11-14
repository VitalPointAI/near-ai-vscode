// REVIEW BLOCKER 1 (agent boundary) and the minor on commandSafety.ts: one shared rule makes every agent write to the state folder, the locks
// folder or a *.git folder ask, and every read of the state folder's keys ask, in the file tools and in the shell guard alike.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { classifyCommand, CommandContext } from '../agent/commandSafety';
import { RunCheckpoints } from '../agent/checkpoints';
import { grepTool, isSensitivePath, protectedWrite, readTool, ToolContext } from '../agent/tools';
import { PROTECTED_WRITE, protectedWriteReason, STATE_FOLDER_PATH, STATE_FOLDER_TEXT } from '../domain/protectedPaths';
import { ShellSession } from '../agent/shell';

const shellContext: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };

async function project(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-protected-'));
  return { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('p'), shell: new ShellSession(root), readFiles: new Set() };
}

test('file tools: a write into the state folder, the locks folder, a *.git folder or .git asks, even with edits allowed for the run', async () => {
  const context = await project();
  for (const asked of [
    '.near-ai/state/meta.json', '.near-ai/state/keys/local.key', '.near-ai/state/sync/hooks/pre-push', '.near-ai/locks/meta.lock',
    'vendor/mirror.git/config', '.git/hooks/pre-commit', '.near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', '.near-ai/scratch/../state/meta.json'
  ]) {
    assert.match(String(await protectedWrite(asked, context)), /Approve this write only if you expect it/, `${asked} should ask`);
  }
  for (const quiet of ['.near-ai/scratch/check.py', '.near-ai/attachments/a.png', '.github/workflows/ci.yml', '.gitignore', 'src/app.ts', '.gitattributes']) {
    assert.equal(await protectedWrite(quiet, context), undefined, `${quiet} should not ask`);
  }
});

test('the sentences: .git and .planning/.near-ai keep their wording, .near-ai and a *.git folder get their own', () => {
  assert.equal(protectedWriteReason('.git/config'), '.git/config is inside .git, where hooks and config run code on the next git command. Approve this write only if you expect it.');
  assert.equal(protectedWriteReason('.planning/.near-ai/x.json'), ".planning/.near-ai/x.json is inside .planning/.near-ai, which holds this project's NEAR AI settings. Approve this write only if you expect it.");
  assert.equal(protectedWriteReason('.near-ai/state/meta.json'), ".near-ai/state/meta.json is inside .near-ai, where NEAR AI keeps this project's saved state, keys and locks. Approve this write only if you expect it.");
  assert.match(String(protectedWriteReason('vendor/mirror.git/config')), /is inside mirror\.git, where hooks and config run code/);
  assert.equal(protectedWriteReason('src/app.ts'), undefined);
  assert.equal(PROTECTED_WRITE.test('.near-ai/scratch/x.py'), false);
  assert.equal(PROTECTED_WRITE.test('.near-ai/scratch-other/x'), true, 'a sibling that only shares the prefix is not the scratch folder');
});

test('reads: the state folder, its previous copies and its keys are sensitive; a similar name is not', async () => {
  for (const file of ['.near-ai/state/keys/recovery.json', '.near-ai/state/keys/api/p.enc', '.near-ai/state/threads/x/log.jsonl', '.near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', '.near-ai/state', '/work/app/.near-ai/state/keys/local.key']) {
    assert.equal(isSensitivePath(file), true, `${file} is sensitive`);
  }
  assert.equal(isSensitivePath('.near-ai/statement.md'), false);
  assert.equal(isSensitivePath('.near-ai/scratch/state.txt'), false);
  assert.equal(STATE_FOLDER_PATH.test('.near-ai/statement.md'), false);
  assert.equal(STATE_FOLDER_TEXT.test('cat .near-ai/statement.md'), false);

  const context = await project();
  const asked = await readTool.sensitive?.(readTool.parse({ file_path: '.near-ai/state/keys/recovery.json' }), context);
  assert.match(String(asked), /looks like it may contain credentials/);
});

test('Grep over the project leaves out the state folder\'s keys unless the search was aimed at them', async () => {
  const context = await project();
  await mkdir(path.join(context.root, '.near-ai', 'state', 'keys'), { recursive: true });
  await mkdir(path.join(context.root, 'src'), { recursive: true });
  await writeFile(path.join(context.root, '.near-ai', 'state', 'keys', 'recovery.json'), '{"code":"needle-secret"}');
  await writeFile(path.join(context.root, 'src', 'a.ts'), 'const needle = 1;\n');
  const wide = await grepTool.run(grepTool.parse({ pattern: 'needle', output_mode: 'content' }), context);
  assert.match(wide, /src\/a\.ts/);
  assert.doesNotMatch(wide, /recovery\.json|needle-secret/);
  const aimed = await grepTool.run(grepTool.parse({ pattern: 'needle', path: '.near-ai/state', output_mode: 'content' }), context);
  assert.match(aimed, /needle-secret/);
  assert.match(String(await grepTool.sensitive?.(grepTool.parse({ pattern: 'needle', path: '.near-ai/state' }), context)), /may contain credentials/);
});

test('shell guard: commands that write the state folder, a *.git folder or read the keys are risky; scratch work and ordinary commands are not', () => {
  const risky = [
    'echo x > .near-ai/state/meta.json', 'cp evil .near-ai/state/keys/local.key', 'mkdir -p .near-ai/state/sync/hooks', 'grep -r token .near-ai/state',
    'cat .near-ai/state/keys/recovery.json', 'tar czf out.tgz .near-ai/state', 'touch .near-ai/locks/meta.lock', 'cp x vendor/mirror.git/config',
    'cat .near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', 'echo x > .near-ai/hooks/pre-push'
  ];
  const wrong = risky.map((command) => ({ command, result: classifyCommand(command, shellContext) })).filter(({ result }) => result.verdict !== 'risky');
  assert.deepEqual(wrong.map(({ command, result }) => `${command} -> ${result.verdict} (${result.reason})`), []);
  for (const command of ['python3 .near-ai/scratch/verify.py', 'ls src', 'cat .near-ai/statement.md', 'touch .near-ai/scratch/a.txt', 'cp a.png .near-ai/attachments/a.png']) {
    assert.notEqual(classifyCommand(command, shellContext).verdict, 'risky', `${command} should not be held`);
  }
});
