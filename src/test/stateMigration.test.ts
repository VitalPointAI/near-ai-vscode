import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentMessage } from '../services/nearAiClient';
import { emptyReport, migrateEditorStorage, type MigrationReport, type MigrationSources } from '../services/stateMigration';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import { hashTree, legacyEditor, type LegacyEditor } from './helpers/legacyStorage';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 10 (SYNC-02, D-05): each editor merges what its own globalStorage holds for the open project into the shared state home, by record id,
// without ever writing to that storage. Every test builds fake editor storage in a temporary folder; nothing here reads a real editor's data.

const AT = '2026-11-05T10:00:00.000Z';

async function tempStorage(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'near-ai-legacy-'));
}

function sourcesFor(root: string, editor: LegacyEditor, writer = 'edA.1', projectScopeId = 'project-test'): MigrationSources {
  return { root, globalStorageDir: editor.dir, oldKey: editor.oldKey, writer, projectScopeId };
}

/** The state home's thread store as an editor with its own SecretStorage sees it. */
function threadsOf(root: string, secrets = new MemorySecrets(), writer = 'edA.1', now?: () => Date): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer, ...(now ? { now } : {}) });
}

async function migrate(root: string, editor: LegacyEditor, store: ThreadStore, writer = 'edA.1'): Promise<MigrationReport> {
  return migrateEditorStorage(sourcesFor(root, editor, writer), stateHomeFor(root), store);
}

const conversation = (): AgentMessage[] => [
  { role: 'system', content: 'You are the NEAR AI agent.' },
  { role: 'user', content: 'Fix the failing test' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'a.test.ts' }) } }] },
  { role: 'tool', tool_call_id: 'call-1', content: 'expected 1 to equal 2' },
  { role: 'assistant', content: 'The assertion was wrong; I fixed it.' }
];

test('tracer: code-server\'s old-key conversation becomes a full thread that another editor with no old key opens', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const keyA = randomBytes(32);
    const editorA = await legacyEditor(storage, root, { key: keyA, transcripts: [{ id: 'conv-fix-test', title: 'Fix the failing test', model: 'deepseek', updatedAt: AT, messages: conversation() }] });

    const report = await migrate(root, editorA, threadsOf(root, editorA.secrets));
    assert.equal(report.threads.copied, 1);
    assert.equal(report.threads.locked, 0);

    // Editor B has its own SecretStorage and never held key A: it opens the thread through the project's data key.
    const editorB = threadsOf(root, new MemorySecrets(), 'edB.1');
    const listed = await editorB.list();
    assert.deepEqual(listed.map((item) => [item.id, item.title, item.locked]), [['conv-fix-test', 'Fix the failing test', undefined]]);
    const lines = await editorB.lines('conv-fix-test');
    assert.deepEqual(lines.branches, []);
    assert.deepEqual(lines.main.map((entry) => entry.role), ['user', 'tool-call', 'tool-result', 'assistant']);
    assert.equal((lines.main[0].body as { text: string }).text, 'Fix the failing test');
    assert.equal((lines.main[3].body as { text: string }).text, 'The assertion was wrong; I fixed it.');
    assert.equal(lines.main.every((entry) => entry.at === AT && entry.writer === 'edA.1'), true);

    // The model's saved working list comes with it, so the conversation continues where it stopped.
    const context = await editorB.load('conv-fix-test');
    assert.equal(context?.messages.length, 5);
    assert.equal(context?.basedOnTip, lines.main.at(-1)?.id);
    const meta = await editorB.meta('conv-fix-test');
    assert.equal(meta?.history, undefined);
    assert.equal(meta?.turns, 1);
    assert.equal(meta?.lastUsedAt, AT);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('migration never touches the editor storage: the hash of its tree is the same before and after, plain and sealed transcripts alike', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const editorA = await legacyEditor(storage, root, {
      key: randomBytes(32),
      transcripts: [{ id: 'conv-sealed-one', updatedAt: AT, messages: conversation() }],
      rawTranscripts: [{ name: 'conv-plain-one', text: JSON.stringify({ id: 'conv-plain-one', title: 'Plain', model: 'm', updatedAt: AT, turns: 1, messages: conversation() }) }],
      decoys: true
    });
    const before = await hashTree(storage);
    const report = await migrate(root, editorA, threadsOf(root, editorA.secrets));
    assert.equal(report.threads.copied, 2);
    assert.equal(await hashTree(storage), before, 'a plain transcript was not re-saved encrypted, and nothing was added, removed or renamed');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('an editor with no storage for the project, or none at all, completes with zero changes and writes nothing into the project', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const empty = await legacyEditor(path.join(storage, 'never-used'), root, {});
    const missing: LegacyEditor = { dir: path.join(storage, 'does-not-exist'), secrets: new MemorySecrets(), oldKey: async () => undefined };
    for (const editor of [empty, missing]) {
      const report = await migrate(root, editor, threadsOf(root));
      assert.deepEqual(report, emptyReport());
    }
    assert.equal(await stateHomeFor(root).exists(), false, 'opening a folder with nothing to migrate must not create the state home');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('a transcript whose old key is not here is reported locked, left in place, and migrated by the next run once the key is there', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const key = randomBytes(32);
    const withKey = await legacyEditor(storage, root, { key, transcripts: [{ id: 'conv-needs-key', updatedAt: AT, messages: conversation() }] });
    const keyless: LegacyEditor = { ...withKey, secrets: new MemorySecrets(), oldKey: async () => undefined };
    const store = threadsOf(root);
    const before = await hashTree(storage);

    const first = await migrate(root, keyless, store);
    assert.equal(first.threads.locked, 1);
    assert.deepEqual(first.lockedIds, ['conv-needs-key']);
    assert.equal(first.threads.copied, 0);
    assert.equal(await stateHomeFor(root).exists(), false);

    // The wrong key is the same as no key.
    const wrong = await migrate(root, { ...withKey, oldKey: async () => randomBytes(32) }, store);
    assert.equal(wrong.threads.locked, 1);

    const second = await migrate(root, withKey, store);
    assert.equal(second.threads.copied, 1);
    assert.equal(second.threads.locked, 0);
    assert.equal((await store.list()).length, 1);
    assert.equal(await hashTree(storage), before);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});
