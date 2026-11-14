import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentConversation } from '../services/agentSession';
import { RunMarkers } from '../services/runMarkers';
import { stateHomeFor } from '../services/stateHome';
import { gitInit, gitStatus, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 04 (SYNC-01): run markers and run checkpoints live in the project's state home, so a second editor on the same project reads
// them. Each test works on a temporary project folder; "two editors" are two store instances with nothing in common but that folder.

const exists = (target: string) => stat(target).then(() => true, () => false);

test('checkpoints in the state home are format 2: inside the project root-relative, outside absolute and marked; a second editor reverts', async () => {
  const root = await tempProject();
  const elsewhere = await tempProject();
  try {
    const home = stateHomeFor(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    const inside = path.join(root, 'src', 'a.ts');
    const outside = path.join(elsewhere, 'b.txt');
    await writeFile(inside, 'original a');
    await writeFile(outside, 'original b');
    const editorA = new RunCheckpoints('run-1-aaaaaa', home.paths.checkpoints, { root, beforeWrite: () => home.ensure() });
    await editorA.capture(inside);
    await editorA.capture(outside);
    await editorA.capture(path.join(root, 'src', 'created.ts'));
    await writeFile(inside, 'changed a');
    await writeFile(outside, 'changed b');
    await writeFile(path.join(root, 'src', 'created.ts'), 'new');
    const saved = JSON.parse(await readFile(path.join(home.paths.checkpoints, 'run-1-aaaaaa.json'), 'utf8')) as { format: number; snapshots: Array<Record<string, unknown>> };
    assert.equal(saved.format, 2);
    assert.deepEqual(saved.snapshots.map((snapshot) => ({ ...snapshot, original: typeof snapshot.original })), [
      { rel: 'src/a.ts', original: 'string' },
      { abs: outside, outside: true, original: 'string' },
      { rel: 'src/created.ts', original: 'object' }
    ]);
    // A checkpoint file is in the project's state folder, so an editor that does not name the outside folder as allowed drops that entry and
    // never writes outside the project (27-29); loading it changes nothing on disk.
    const unbounded = await RunCheckpoints.load('run-1-aaaaaa', home.paths.checkpoints, { root });
    assert.ok(unbounded, 'the run loads without the outside folder');
    assert.equal(await readFile(outside, 'utf8'), 'changed b', 'loading touches nothing');
    // Editor B: another instance over the same folder, as another window or the browser would be, with the outside folder allowed (as the
    // agent's own worktree is).
    const editorB = await RunCheckpoints.load('run-1-aaaaaa', home.paths.checkpoints, { root, allowedRoots: [elsewhere] });
    assert.ok(editorB, 'a second editor finds the run');
    await editorB.revert();
    assert.equal(await readFile(inside, 'utf8'), 'original a');
    assert.equal(await readFile(outside, 'utf8'), 'original b', 'an outside file keeps today\'s same-machine behaviour');
    assert.equal(await exists(path.join(root, 'src', 'created.ts')), false);
    assert.equal(await exists(path.join(home.paths.checkpoints, 'run-1-aaaaaa.json')), false, 'a reverted run leaves no checkpoint file');
  } finally { await rm(root, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); }
});

test('a project moved to another path still reverts: relative paths are resolved against the current root', async () => {
  const first = await tempProject();
  const second = await tempProject();
  try {
    await writeFile(path.join(first, 'a.txt'), 'before');
    const store = path.join(first, 'ckpt');
    const checkpoints = new RunCheckpoints('run-2-bbbbbb', store, { root: first });
    await checkpoints.capture(path.join(first, 'a.txt'));
    await writeFile(path.join(second, 'a.txt'), 'changed on the other machine');
    const loaded = await RunCheckpoints.load('run-2-bbbbbb', store, { root: second });
    assert.deepEqual(loaded?.changedFiles, [path.join(second, 'a.txt')]);
    await loaded!.revert();
    assert.equal(await readFile(path.join(second, 'a.txt'), 'utf8'), 'before');
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test('a format 1 checkpoint file (absolute paths only) still loads and reverts', async () => {
  const root = await tempProject();
  try {
    const file = path.join(root, 'old.txt');
    await writeFile(file, 'edited by the old version');
    const store = path.join(root, 'ckpt');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, 'run-3-cccccc.json'), JSON.stringify([{ path: file, original: Buffer.from('as it was').toString('base64') }]));
    const loaded = await RunCheckpoints.load('run-3-cccccc', store, { root });
    assert.ok(loaded);
    await loaded.revert();
    assert.equal(await readFile(file, 'utf8'), 'as it was');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('T-27-17: a relative path that climbs out of the root or is absolute is refused on load, so a revert never writes outside the project', async () => {
  const root = await tempProject();
  const victim = await tempProject();
  try {
    const store = path.join(root, 'ckpt');
    await mkdir(store, { recursive: true });
    const target = path.join(victim, 'victim.txt');
    await writeFile(target, 'must stay');
    const content = Buffer.from('planted').toString('base64');
    const climbing = path.relative(root, target);
    assert.ok(climbing.startsWith('..'));
    await writeFile(path.join(store, 'run-4-dddddd.json'), JSON.stringify({
      format: 2,
      snapshots: [
        { rel: climbing, original: content },
        { rel: target, original: content },
        { rel: 'ok/../../escape.txt', original: content },
        { rel: '', original: content },
        { rel: '.', original: content },
        { rel: 'fine.txt', original: content },
        { rel: 'bad-original.txt', original: 5 }
      ]
    }));
    const loaded = await RunCheckpoints.load('run-4-dddddd', store, { root });
    assert.deepEqual(loaded?.changedFiles, [path.join(root, 'fine.txt')], 'only the contained path survives');
    // Without a root a relative path cannot be placed, so it is dropped rather than resolved against the working directory.
    assert.deepEqual((await RunCheckpoints.load('run-4-dddddd', store))?.changedFiles, []);
    await loaded!.revert();
    assert.equal(await readFile(target, 'utf8'), 'must stay');
  } finally { await rm(root, { recursive: true, force: true }); await rm(victim, { recursive: true, force: true }); }
});

test('D-04: the first checkpoint and the first run marker in a fresh project write the inner .gitignore before anything else, and git sees nothing', async () => {
  const root = await tempProject();
  try {
    gitInit(root);
    const home = stateHomeFor(root);
    assert.equal(await exists(home.dir), false, 'opening a folder creates nothing');
    const seen: string[] = [];
    const prepare = async () => {
      seen.push(`before: checkpoints=${await exists(home.paths.checkpoints)} runs=${await exists(home.paths.runs)}`);
      await home.ensure();
      seen.push(`after: gitignore=${await exists(home.paths.gitignore)}`);
    };
    await writeFile(path.join(root, 'a.txt'), 'x');
    await new RunCheckpoints('run-5-eeeeee', home.paths.checkpoints, { root, beforeWrite: prepare }).capture(path.join(root, 'a.txt'));
    await new RunMarkers('', root, { dir: home.paths.runs, writer: 'edaaaaaa.inst0001', beforeWrite: () => home.ensure() }).start({ conversationId: 'conv-fresh0-0a0b0c0d', runId: 'run-1793570629237-876b3a' });
    assert.deepEqual(seen, ['before: checkpoints=false runs=false', 'after: gitignore=true']);
    assert.equal(await readFile(home.paths.gitignore, 'utf8'), '*\n');
    assert.deepEqual((await readdir(home.paths.runs)), ['conv-fresh0-0a0b0c0d.json']);
    assert.equal(gitStatus(root).replace(/\?\? a\.txt\n?/, ''), '', 'the state folder is invisible to git (only the test\'s own a.txt shows)');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two editors share the markers: a run started by one is read, and settled, by the other', async () => {
  const root = await tempProject();
  try {
    const dir = stateHomeFor(root).paths.runs;
    const now = { value: Date.parse('2026-11-12T10:00:00.000Z') };
    const desktop = new RunMarkers('', root, { dir, writer: 'edaaaaaa.inst0001', pid: 100, now: () => now.value });
    const browser = new RunMarkers('', root, { dir, writer: 'edbbbbbb.inst0001', pid: 100, now: () => now.value, alive: () => true });
    await desktop.start({ conversationId: 'conv-shared-0a0b0c0d', runId: 'run-1793570629237-876b3a', model: 'z-ai/glm-5.3' });
    await desktop.step('conv-shared-0a0b0c0d', 'run-1793570629237-876b3a', 'Edit');
    const seen = await browser.markerOf('conv-shared-0a0b0c0d');
    assert.equal(seen?.model, 'z-ai/glm-5.3');
    assert.deepEqual(seen?.steps, ['Edit']);
    assert.equal(browser.runState(seen!), 'running-elsewhere');
    now.value += 10 * 60_000;
    await browser.settle('conv-shared-0a0b0c0d', 'dismissed');
    assert.equal(browser.runState((await desktop.markerOf('conv-shared-0a0b0c0d'))!), 'finished', 'a click in the other editor settles it for everyone');
    desktop.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sub-agent worktrees stay in the editor\'s own storage, never inside the project', async () => {
  const root = await tempProject();
  const storage = await tempProject();
  try {
    const conversation = new AgentConversation(root, () => undefined, stateHomeFor(root).paths.checkpoints);
    const dir = () => (conversation as unknown as { worktreeDir: string }).worktreeDir;
    conversation.worktreeRoot = path.join(storage, 'worktrees');
    assert.equal(dir(), path.join(storage, 'worktrees'));
    assert.equal(path.relative(root, dir()).startsWith('..'), true, 'not under the project');
    conversation.worktreeRoot = undefined;
    assert.equal(dir(), path.join(path.dirname(stateHomeFor(root).paths.checkpoints), 'worktrees'), 'the old derivation remains for callers that do not set it');
  } finally { await rm(root, { recursive: true, force: true }); await rm(storage, { recursive: true, force: true }); }
});
