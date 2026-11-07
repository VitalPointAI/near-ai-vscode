// Scratch work stays inside the project and leaves nothing behind (owner, 2026-11-06). These pin the folder, the gitignore lines and the cleanup.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SCRATCH_DIR, SCRATCH_INSTRUCTIONS, gitignoreAdditions, isScratchPath, scratchFolder } from '../domain/scratch';
import { cleanScratch, ensureScratch } from '../services/scratch';

test('scratch work lives in one folder inside the project, and the run is told so', () => {
  assert.equal(SCRATCH_DIR, '.near-ai/scratch');
  assert.equal(scratchFolder('/work/app'), path.join('/work/app', '.near-ai', 'scratch'));
  // The sentence names the folder, forbids /tmp, and says both that it is ignored and that it is emptied.
  assert.match(SCRATCH_INSTRUCTIONS, /\.near-ai\/scratch\//);
  assert.match(SCRATCH_INSTRUCTIONS, /never in \/tmp or anywhere else on the machine/);
  assert.match(SCRATCH_INSTRUCTIONS, /ignored by git/);
  assert.match(SCRATCH_INSTRUCTIONS, /emptied when the run ends/);
  assert.match(SCRATCH_INSTRUCTIONS, /inside the project/);
});

test('a path counts as scratch only when it is inside the scratch folder', () => {
  const root = '/work/app';
  assert.equal(isScratchPath(root, '.near-ai/scratch/verify.py'), true);
  assert.equal(isScratchPath(root, '/work/app/.near-ai/scratch/deep/page.html'), true);
  assert.equal(isScratchPath(root, '.near-ai/attachments/a.pdf'), false);
  assert.equal(isScratchPath(root, 'src/app.ts'), false);
  // The scratch folder itself is not "inside" itself, and a sibling with the same prefix is not either.
  assert.equal(isScratchPath(root, '.near-ai/scratch'), false);
  assert.equal(isScratchPath(root, '.near-ai/scratch-other/x'), false);
});

test('the gitignore is given the scratch folder once, and nothing when a rule already covers it', () => {
  assert.deepEqual(gitignoreAdditions(''), ['.near-ai/scratch/', '.near-ai/attachments/']);
  assert.deepEqual(gitignoreAdditions('node_modules/\n'), ['.near-ai/scratch/', '.near-ai/attachments/']);
  // A project that ignores the whole folder needs nothing more.
  assert.deepEqual(gitignoreAdditions('.near-ai/\n'), []);
  assert.deepEqual(gitignoreAdditions('.near-ai\n'), []);
  // One of the two already there: only the other is added.
  assert.deepEqual(gitignoreAdditions('.near-ai/scratch/\n'), ['.near-ai/attachments/']);
  // A negated rule does not count as covering it.
  assert.deepEqual(gitignoreAdditions('!.near-ai/\n'), ['.near-ai/scratch/', '.near-ai/attachments/']);
});

test('a project is given the scratch folder and its ignore lines, and the lines are not added twice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-scratch-'));
  await ensureScratch(root);
  assert.equal(existsSync(scratchFolder(root)), true, 'the folder exists');
  const first = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(first, /\.near-ai\/scratch\//);
  await ensureScratch(root);
  const second = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.equal(second, first, 'a second call changes nothing');
});

test('cleaning empties the scratch folder but keeps the folder, and never touches anything else', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-scratch-clean-'));
  await mkdir(path.join(scratchFolder(root), 'deep'), { recursive: true });
  await writeFile(path.join(scratchFolder(root), 'verify.py'), 'print(1)');
  await writeFile(path.join(scratchFolder(root), 'deep', 'page.html'), '<html>');
  await writeFile(path.join(root, 'keep.txt'), 'the work');
  const removed = await cleanScratch(root);
  assert.equal(removed, 2, 'both files are gone');
  assert.equal(existsSync(scratchFolder(root)), true, 'the folder stays, so the next run has one');
  assert.deepEqual(await readdir(scratchFolder(root)), []);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'the work', 'the project is untouched');
  // Cleaning a project with no scratch folder is not an error.
  assert.equal(await cleanScratch(await mkdtemp(path.join(tmpdir(), 'near-ai-scratch-none-'))), 0);
});
