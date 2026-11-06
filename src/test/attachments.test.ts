// Attachments (0.4.18): a file picked from anywhere on the machine is copied into the project when the message is sent, so the agent can open it with
// its own file tools instead of going to look for it on disk.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { copyAttachmentIntoProject, stageAttachment } from '../agent/attachments';


// ---- 0.4.18: an attached file is copied into the project, so the agent's own tools can reach it (owner, 2026-11-06) ---------------------
test('an attachment from outside the project is saved into the project, with the same name and bytes', async () => {
  const { copyAttachmentIntoProject } = await import('../agent/attachments');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-copy-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-outside-'));
  // A text file keeps this test about the copy; a PDF would also be parsed, which the document tests cover.
  const file = path.join(outside, 'Sterling_Sovereign_AI_Proposal_v0.9.md');
  await writeFile(file, Buffer.from('# A proposal'));
  const staged = await stageAttachment(file);
  const saved = await copyAttachmentIntoProject(staged, root);
  assert.equal(saved, path.join('.near-ai', 'attachments', 'Sterling_Sovereign_AI_Proposal_v0.9.md'), 'a path inside the project');
  assert.deepEqual(await readFile(path.join(root, saved as string)), Buffer.from('# A proposal'), 'the bytes are the same');
});

test('the same file attached twice is one copy, and a different file with the same name gets its own', async () => {
  const { copyAttachmentIntoProject } = await import('../agent/attachments');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-dup-'));
  const a = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-a-'));
  const b = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-b-'));
  await writeFile(path.join(a, 'notes.txt'), 'first');
  await writeFile(path.join(b, 'notes.txt'), 'second, different');
  const one = await copyAttachmentIntoProject(await stageAttachment(path.join(a, 'notes.txt')), root);
  const again = await copyAttachmentIntoProject(await stageAttachment(path.join(a, 'notes.txt')), root);
  assert.equal(again, one, 'the same bytes reuse the copy');
  const other = await copyAttachmentIntoProject(await stageAttachment(path.join(b, 'notes.txt')), root);
  assert.notEqual(other, one, 'a different file is not overwritten');
  assert.equal(await readFile(path.join(root, other as string), 'utf8'), 'second, different');
  // Both copies are in the project, and the first one still has its own bytes.
  assert.equal(await readFile(path.join(root, one as string), 'utf8'), 'first');
});
