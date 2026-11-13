// REVIEW MAJOR checkpoints.ts:100: checkpoints live in the project, so a saved file must never decide which files outside the workspace Revert
// writes or deletes. Loading drops paths outside the project and this editor's worktrees, and Revert checks each real path again.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';

const b64 = (text: string) => Buffer.from(text).toString('base64');

async function layout() {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-ckpt-bounds-'));
  const root = path.join(base, 'project');
  const worktrees = path.join(base, 'worktrees');
  const outside = path.join(base, 'elsewhere');
  const storage = path.join(root, '.near-ai', 'state', 'checkpoints');
  for (const folder of [root, worktrees, outside, storage]) await mkdir(folder, { recursive: true });
  const victim = path.join(outside, 'victim.txt');
  await writeFile(victim, 'victim original');
  const save = (runId: string, content: unknown) => writeFile(path.join(storage, `${runId}.json`), JSON.stringify(content));
  return { base, root, worktrees, outside, storage, victim, save };
}

test('a format 2 checkpoint with outside entries reverts nothing outside, and still reverts what is inside', async () => {
  const { root, worktrees, outside, storage, victim, save } = await layout();
  const mine = path.join(root, 'src.txt');
  await writeFile(mine, 'changed');
  const created = path.join(outside, 'created-by-run.txt');
  await writeFile(created, 'not the run\'s to delete');
  await save('run-1', { format: 2, snapshots: [
    { abs: victim, outside: true, original: b64('planted') },
    { abs: created, outside: true, original: null },
    { rel: 'src.txt', original: b64('original') }
  ] });
  const loaded = await RunCheckpoints.load('run-1', storage, { root, allowedRoots: [worktrees] });
  assert.ok(loaded);
  assert.deepEqual(loaded.changedFiles, [mine], 'the outside entries were dropped on load');
  const restored = await loaded.revert();
  assert.deepEqual(restored, [mine]);
  assert.equal(await readFile(victim, 'utf8'), 'victim original');
  assert.equal(await readFile(created, 'utf8'), 'not the run\'s to delete');
  assert.equal(await readFile(mine, 'utf8'), 'original');
});

test('a format 1 list of absolute paths outside both roots touches nothing outside', async () => {
  const { root, worktrees, outside, storage, victim, save } = await layout();
  const inside = path.join(root, 'a.txt');
  await writeFile(inside, 'changed');
  await save('run-2', [{ path: victim, original: b64('planted') }, { path: path.join(outside, 'new.txt'), original: null }, { path: inside, original: b64('original') }]);
  const loaded = await RunCheckpoints.load('run-2', storage, { root, allowedRoots: [worktrees] });
  assert.ok(loaded);
  assert.deepEqual(loaded.changedFiles, [inside]);
  await loaded.revert();
  assert.equal(await readFile(victim, 'utf8'), 'victim original');
  assert.equal(existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(await readFile(inside, 'utf8'), 'original');
});

test('a file in this editor\'s sub-agent worktree folder still reverts, and without allowedRoots only the project loads', async () => {
  const { root, worktrees, storage, save } = await layout();
  const treeFile = path.join(worktrees, 'agent-1', 'f.txt');
  await mkdir(path.dirname(treeFile), { recursive: true });
  await writeFile(treeFile, 'changed');
  await save('run-3', { format: 2, snapshots: [{ abs: treeFile, outside: true, original: b64('original') }] });
  const withRoots = await RunCheckpoints.load('run-3', storage, { root, allowedRoots: [worktrees] });
  assert.deepEqual(withRoots?.changedFiles, [treeFile]);
  assert.deepEqual(await withRoots?.revert(), [treeFile]);
  assert.equal(await readFile(treeFile, 'utf8'), 'original');

  await writeFile(treeFile, 'changed again');
  await save('run-4', { format: 2, snapshots: [{ abs: treeFile, outside: true, original: b64('original') }] });
  const without = await RunCheckpoints.load('run-4', storage, { root });
  assert.deepEqual(without?.changedFiles, []);
  await without?.revert();
  assert.equal(await readFile(treeFile, 'utf8'), 'changed again');
});

test('a folder inside the project that became a link to a folder outside is not written through', async () => {
  const { root, worktrees, outside, storage, victim, save } = await layout();
  // Saved while `link` did not exist (or was an ordinary folder); a link planted afterwards points at the outside folder.
  await save('run-5', { format: 2, snapshots: [{ rel: 'link/victim.txt', original: b64('planted') }, { rel: 'link/gone.txt', original: null }] });
  await writeFile(path.join(outside, 'gone.txt'), 'must stay');
  await symlink(outside, path.join(root, 'link'));
  const loaded = await RunCheckpoints.load('run-5', storage, { root, allowedRoots: [worktrees] });
  assert.ok(loaded);
  assert.equal(loaded.changedFiles.length, 2, 'the paths are inside the project as written');
  assert.deepEqual(await loaded.revert(), [], 'neither is restored');
  assert.equal(await readFile(victim, 'utf8'), 'victim original');
  assert.equal(await readFile(path.join(outside, 'gone.txt'), 'utf8'), 'must stay');
  assert.equal(existsSync(path.join(root, 'link')), true, 'the link itself is left');
});

test('a snapshot taken in memory of a path outside both roots is not reverted either', async () => {
  const { root, worktrees, storage, victim } = await layout();
  const checkpoints = new RunCheckpoints('run-6', storage, { root, allowedRoots: [worktrees] });
  await checkpoints.capture(victim);
  await writeFile(victim, 'changed by something else');
  assert.deepEqual(await checkpoints.revert(), []);
  assert.equal(await readFile(victim, 'utf8'), 'changed by something else');
});

test('a normal run still saves, loads and reverts a file inside the project', async () => {
  const { root, worktrees, storage } = await layout();
  const file = path.join(root, 'sub', 'x.txt');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'original');
  const checkpoints = new RunCheckpoints('run-7', storage, { root, allowedRoots: [worktrees] });
  await checkpoints.capture(file);
  const created = path.join(root, 'sub', 'deeper', 'new.txt');
  await checkpoints.capture(created);
  await mkdir(path.dirname(created), { recursive: true });
  await writeFile(created, 'new');
  await writeFile(file, 'changed');
  const loaded = await RunCheckpoints.load('run-7', storage, { root, allowedRoots: [worktrees] });
  assert.deepEqual((await loaded?.revert())?.sort(), [created, file].sort());
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.equal(existsSync(created), false);
});
