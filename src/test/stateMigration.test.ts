import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { ActivityStore } from '../services/activityStore';
import type { AgentMessage } from '../services/nearAiClient';
import { ComparisonStore } from '../benchmark/store';
import { RunMarkers } from '../services/runMarkers';
import { formatProjectSpend, mirrorProjectSpend, projectSpendSection, readProjectSpend } from '../services/spendMirror';
import { changesIn, configureMigration, emptyReport, ensureMigrated, migrateEditorStorage, type MigrationOptions, type MigrationReport, type MigrationSources } from '../services/stateMigration';
import { stateHomeFor, writeFileAtomic } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import { hashTree, legacyEditor, savedRunFixture, type LegacyEditor } from './helpers/legacyStorage';
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

async function migrate(root: string, editor: LegacyEditor, store: ThreadStore, writer = 'edA.1', options: MigrationOptions = {}, projectScopeId = 'project-test'): Promise<MigrationReport> {
  return migrateEditorStorage(sourcesFor(root, editor, writer, projectScopeId), stateHomeFor(root), store, options);
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

// ---- plan 10, task 2: markers, checkpoints, comparisons, spend; idempotence, order, crash, retention -----------------------------------------------

const SCOPE = 'project-aaaaaaaaaaaaaaaa';
const OTHER_SCOPE = 'project-bbbbbbbbbbbbbbbb';
const minute = (n: number): string => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
const thread = (n: number, extra = ''): { id: string; title: string; updatedAt: string; messages: AgentMessage[] } => ({
  id: `conv-mig-${String(n).padStart(4, '0')}`, title: `Thread ${n}${extra}`, updatedAt: minute(n),
  messages: [{ role: 'system', content: 'You are the NEAR AI agent.' }, { role: 'user', content: `Question ${n}${extra}` }, { role: 'assistant', content: `Answer ${n}${extra}` }]
});

async function files(dir: string): Promise<Array<[string, string]>> {
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  return Promise.all(names.map(async (name): Promise<[string, string]> => [name, await readFile(path.join(dir, name), 'utf8').catch(() => '')]));
}

/** What a person would see in the state home, with no random bytes in it: the same for two runs that did the same merges in any order or with a crash between. */
async function logical(root: string): Promise<unknown> {
  const home = stateHomeFor(root);
  const store = threadsOf(root, new MemorySecrets(), 'reader.1');
  const items = (await store.index()).filter((item) => !item.locked).sort((a, b) => (a.id < b.id ? -1 : 1));
  const threads: unknown[] = [];
  for (const item of items) {
    const base = { id: item.id, title: item.title, model: item.model, state: item.state, lastUsedAt: item.lastUsedAt, turns: item.turns, entries: item.entries, tip: item.tip, history: item.history };
    if (item.state !== 'live') { threads.push(base); continue; }
    const entries = (await store.entries(item.id)).map((entry) => [entry.id, entry.parent, entry.role, entry.body]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
    const context = await store.load(item.id);
    threads.push({ ...base, entries, context: context ? { messages: context.messages, updatedAt: context.updatedAt, basedOnTip: context.basedOnTip } : null });
  }
  return { threads, runs: await files(home.paths.runs), checkpoints: await files(home.paths.checkpoints), comparisons: await files(home.paths.comparisons), spend: await files(home.paths.spend) };
}

async function writeMarker(root: string, marker: Record<string, unknown>): Promise<void> {
  const home = stateHomeFor(root);
  await home.ensure();
  await mkdir(home.paths.runs, { recursive: true });
  await writeFileAtomic(path.join(home.paths.runs, `${marker.conversationId as string}.json`), `${JSON.stringify(marker)}\n`);
}

test('a conversation marked partial when its earlier messages were summarised away, and a plain one is not', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const summarised: AgentMessage[] = [
      { role: 'system', content: 'You are the NEAR AI agent.' },
      { role: 'user', content: '<conversation-summary>The person asked for a login page and we built it.</conversation-summary>' },
      { role: 'assistant', content: 'Understood. Continuing from the summary.' },
      { role: 'user', content: 'Now add a logout button' },
      { role: 'assistant', content: 'Added.' }
    ];
    const editor = await legacyEditor(storage, root, { key: randomBytes(32), transcripts: [{ id: 'conv-summarised', updatedAt: AT, messages: summarised }, { id: 'conv-plain-chat', updatedAt: AT, messages: conversation() }] });
    const store = threadsOf(root, editor.secrets);
    const report = await migrate(root, editor, store);
    assert.equal(report.threads.copied, 2);
    assert.equal(report.threads.partial, 1);
    assert.equal((await store.meta('conv-summarised'))?.history, 'partial-before-0.4.20');
    assert.equal((await store.meta('conv-plain-chat'))?.history, undefined);
    // The summary itself is not a message the person typed: the thread holds only what was typed and answered.
    const main = (await store.lines('conv-summarised')).main;
    assert.deepEqual(main.map((entry) => entry.role), ['user', 'assistant']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('running the migration twice: the second run reports zero changes and the state home is byte for byte the same', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const editor = await legacyEditor(storage, root, {
      key: randomBytes(32), transcripts: [thread(1), thread(2)],
      markers: [{ conversationId: 'conv-mig-0001', runId: 'run-1793000000000-abcdef', activeAt: AT }],
      evals: [savedRunFixture('2026-11-12T09-30-00-000Z')],
      spend: [{ identity: 'idA', month: '2026-11', lines: [{ t: 'e', id: 'e1', v: 1, at: Date.UTC(2026, 10, 3), path: '/v1/chat', proj: SCOPE, st: 'completed', est: 1000 }] }]
    });
    const store = threadsOf(root, editor.secrets);
    const first = await migrate(root, editor, store, 'edA.1', {}, SCOPE);
    assert.ok(changesIn(first) > 0);
    const state = await hashTree(stateHomeFor(root).dir);
    const second = await migrate(root, editor, store, 'edA.1', {}, SCOPE);
    assert.equal(changesIn(second), 0);
    assert.equal(second.threads.unchanged, 2);
    assert.equal(await hashTree(stateHomeFor(root).dir), state);
    // A fresh process (new stores and secrets for the same editor) finds the same.
    const third = await migrate(root, editor, threadsOf(root, editor.secrets), 'edA.1', {}, SCOPE);
    assert.equal(changesIn(third), 0);
    assert.equal(await hashTree(stateHomeFor(root).dir), state);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('migration never replaces newer: a conversation continued in the state home keeps its later context, its later time and its title', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const old = thread(1);
    const editor = await legacyEditor(storage, root, { key: randomBytes(32), transcripts: [old] });
    const store = threadsOf(root, editor.secrets, 'edA.1', () => new Date('2026-11-13T12:00:00.000Z'));
    await migrate(root, editor, store);
    // The person continues it in 0.4.20: a later context and a later last use are saved.
    const continued = { ...(await store.load(old.id))!, title: 'Renamed since', updatedAt: '2026-11-12T08:00:00.000Z', messages: [...old.messages, { role: 'user' as const, content: 'Another question' }, { role: 'assistant' as const, content: 'Another answer' }], turns: 2 };
    await store.save(continued);
    const before = await logical(root);
    const again = await migrate(root, editor, store);
    assert.equal(changesIn(again), 0);
    assert.deepEqual(await logical(root), before);
    const context = await store.load(old.id);
    assert.equal(context?.messages.length, 5);
    assert.equal(context?.title, 'Renamed since');
    assert.equal((await store.meta(old.id))?.title, 'Renamed since');
    assert.equal((await store.meta(old.id))?.lastUsedAt, '2026-11-12T08:00:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('the same conversation in both editors is one thread; one continued differently in each keeps both lines and loses nothing', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const base: AgentMessage[] = [{ role: 'system', content: 'You are the NEAR AI agent.' }, { role: 'user', content: 'Plan the release' }, { role: 'assistant', content: 'Here is the plan.' }];
    const a = await legacyEditor(path.join(storage, 'a'), root, { key: randomBytes(32), transcripts: [{ id: 'conv-shared-one', updatedAt: minute(5), messages: base }, { id: 'conv-same-both', updatedAt: minute(5), messages: base }] });
    const b = await legacyEditor(path.join(storage, 'b'), root, { key: randomBytes(32), transcripts: [{ id: 'conv-shared-one', updatedAt: minute(9), messages: [...base, { role: 'user', content: 'Add a changelog' }, { role: 'assistant', content: 'Added.' }] }, { id: 'conv-same-both', updatedAt: minute(5), messages: base }] });
    const store = threadsOf(root);
    await migrate(root, a, store, 'edA.1');
    const second = await migrate(root, b, store, 'edB.1');
    // The identical conversation is kept once: nothing new to add.
    assert.equal(second.threads.unchanged, 1);
    assert.equal(second.threads.merged, 1);
    assert.equal((await store.entries('conv-same-both')).length, 2);
    // The longer one is the same chain with two more entries, so it is one line, not a fork.
    const lines = await store.lines('conv-shared-one');
    assert.deepEqual(lines.branches, []);
    assert.equal(lines.main.length, 4);
    assert.equal((await store.meta('conv-shared-one'))?.lastUsedAt, minute(9));

    // Two continuations of the same start: both are kept, one as the main line and one as a labelled other line.
    const c = await legacyEditor(path.join(storage, 'c'), root, { key: randomBytes(32), transcripts: [{ id: 'conv-forked-one', updatedAt: minute(5), messages: [...base, { role: 'user', content: 'Version A' }] }] });
    const d = await legacyEditor(path.join(storage, 'd'), root, { key: randomBytes(32), transcripts: [{ id: 'conv-forked-one', updatedAt: minute(6), messages: [...base, { role: 'user', content: 'Version B' }] }] });
    await migrate(root, c, store, 'edC.1');
    await migrate(root, d, store, 'edD.1');
    const forked = await store.lines('conv-forked-one');
    const texts = [...forked.main, ...forked.branches.flatMap((branch) => branch.entries)].map((entry) => (entry.body as { text: string }).text);
    assert.ok(texts.includes('Version A') && texts.includes('Version B'), 'both continuations are in the thread');
    assert.equal(texts.filter((text) => text === 'Plan the release').length, 1, 'the shared start is kept once');
    // The later saved context wins as the working list.
    assert.equal((await store.load('conv-forked-one'))?.messages.at(-1)?.content, 'Version B');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('run markers: a run in flight at upgrade is offered for resume, a later marker in the state home is kept, a malformed one is skipped', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    await writeMarker(root, { version: 2, conversationId: 'conv-newer-here', runId: 'run-1793000000002-bbbbbb', pid: 1, writer: 'editorb1.inst00001', startedAt: minute(30), activeAt: minute(40), steps: [] });
    await writeMarker(root, { version: 2, conversationId: 'conv-ended-here', runId: 'run-1793000000003-cccccc', pid: 1, writer: 'editorb1.inst00001', startedAt: minute(1), activeAt: minute(2), endedAt: minute(3), outcome: 'completed', steps: [] });
    const editor = await legacyEditor(storage, root, {
      markers: [
        { conversationId: 'conv-in-flight', runId: 'run-1793000000001-aaaaaa', activeAt: minute(20), steps: ['Edit'] },
        { conversationId: 'conv-newer-here', runId: 'run-1793000000002-bbbbbb', activeAt: minute(10) },
        { conversationId: 'conv-ended-here', runId: 'run-1793000000004-dddddd', activeAt: minute(50) }
      ],
      rawMarkers: [{ name: 'conv-broken-one', text: '{"version":9,"conversationId":"conv-broken-one"}' }, { name: 'conv-not-json-1', text: 'not json' }]
    });
    const before = await hashTree(storage);
    const report = await migrate(root, editor, threadsOf(root, editor.secrets));
    assert.equal(report.markers, 2, 'the in-flight run and the later run of a conversation that had ended');
    assert.equal(report.skipped, 2);
    assert.equal(await hashTree(storage), before);

    const markers = new RunMarkers(storage, root, { dir: stateHomeFor(root).paths.runs, writer: 'editora1.inst00002', now: () => Date.parse(minute(20)) + 3_600_000, alive: () => false });
    const cutOff = await markers.interrupted();
    assert.ok(cutOff.some((marker) => marker.conversationId === 'conv-in-flight' && marker.steps.includes('Edit')), 'the run in flight at upgrade can still be offered for resume');
    assert.equal((await markers.markerOf('conv-newer-here'))?.activeAt, minute(40), 'a later marker in the state home is kept');
    assert.equal((await markers.markerOf('conv-ended-here'))?.runId, 'run-1793000000004-dddddd', 'a later run of a conversation whose earlier run ended is taken');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('checkpoints: only this project\'s are copied, as format 2 with paths relative to the project, and they load and revert on any machine', async () => {
  const root = await tempProject();
  const other = await tempProject();
  const storage = await tempStorage();
  try {
    await new ActivityStore(root).start({ project: 'near-ai-test', runId: 'run-1793000000012-bbbbbb', conversationId: 'conv-by-activity', title: 'by activity' });
    await new ActivityStore(root).flush();
    const outside = path.join(storage, 'outside-note.txt');
    const editor = await legacyEditor(storage, root, {
      checkpoints: [
        { runId: 'run-1793000000011-aaaaaa', snapshots: [{ path: path.join(root, 'src', 'a.ts'), original: Buffer.from('old a').toString('base64') }, { path: outside, original: null }] },
        { runId: 'run-1793000000012-bbbbbb', snapshots: [{ path: outside, original: Buffer.from('old note').toString('base64') }] },
        { runId: 'run-1793000000013-cccccc', snapshots: [{ path: path.join(other, 'src', 'z.ts'), original: Buffer.from('other project').toString('base64') }] }
      ]
    });
    const before = await hashTree(storage);
    const report = await migrate(root, editor, threadsOf(root, editor.secrets));
    assert.equal(report.checkpoints, 2);
    assert.equal(await hashTree(storage), before);
    const home = stateHomeFor(root);
    assert.deepEqual((await readdir(home.paths.checkpoints)).sort(), ['run-1793000000011-aaaaaa.json', 'run-1793000000012-bbbbbb.json']);
    const saved = JSON.parse(await readFile(path.join(home.paths.checkpoints, 'run-1793000000011-aaaaaa.json'), 'utf8')) as { format: number; snapshots: Array<Record<string, unknown>> };
    assert.equal(saved.format, 2);
    assert.deepEqual(saved.snapshots.map((snapshot) => snapshot.rel ?? snapshot.abs), ['src/a.ts', outside]);
    assert.equal(JSON.stringify(saved).includes(root), false, 'no absolute path inside the project is kept');
    const loaded = await RunCheckpoints.load('run-1793000000011-aaaaaa', home.paths.checkpoints, { root });
    assert.deepEqual(loaded?.changedFiles.sort(), [path.join(root, 'src', 'a.ts'), outside].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('comparisons: saved runs are copied when absent, a damaged or unrelated file is skipped, and a newer run in the state home is kept', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const mine = savedRunFixture('2026-11-12T09-30-00-000Z');
    const there = savedRunFixture('2026-11-06T09-30-00-000Z', { status: 'completed', finishedAt: '2026-11-06T09:45:00.000Z' });
    const home = stateHomeFor(root);
    await home.ensure();
    await mkdir(home.paths.comparisons, { recursive: true });
    await writeFileAtomic(path.join(home.paths.comparisons, `${there.id}.json`), `${JSON.stringify({ ...there, models: [...there.models, { id: 'model-b', privacy: 'tee', catalogVersion: 'v1' }] }, null, 2)}\n`);
    const editor = await legacyEditor(storage, root, { evals: [mine, { ...there, finishedAt: '2026-11-06T09:31:00.000Z' }], rawEvals: [{ name: 'notes', text: 'hello' }, { name: '2026-11-07T09-30-00-000Z', text: '{"format":"other"}' }] });
    const before = await hashTree(storage);
    const report = await migrate(root, editor, threadsOf(root, editor.secrets));
    assert.equal(report.comparisons, 1);
    assert.equal(report.skipped, 1, 'the unrelated and damaged files are left out (a name that is not a run is not even looked at)');
    assert.equal(await hashTree(storage), before);
    assert.deepEqual((await readdir(home.paths.comparisons)).sort(), [`${there.id}.json`, `${mine.id}.json`].sort());
    assert.equal(JSON.parse(await readFile(path.join(home.paths.comparisons, `${there.id}.json`), 'utf8')).models.length, 2, 'the later copy in the state home is kept');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

// G-27-2: a comparison an older build saved with mode "run" (the current value is "rerun") was dropped as unreadable, so it never reached the state home.
function olderModeRun(id: string): string {
  const row = (model: string, task: string): object => ({ model, task, kind: 'research', taskVersion: '1', run: 1, score: 3, outOf: 4, outcome: 'completed', seconds: 12, turns: 4, inputTokens: 900, outputTokens: 300, generatingMs: 2000, costUsd: 0.002, costEstimated: false, stalls: 0, misses: [], at: '2026-11-08T00:30:00.000Z' });
  return `${JSON.stringify({
    format: 'near-ai-model-comparison', version: 1, id, startedAt: '2026-11-08T00:28:34.953Z', finishedAt: '2026-11-08T00:40:00.000Z', status: 'completed', taskSet: 'full', mode: 'run', runsPerTask: 1,
    models: [{ id: 'model-a', privacy: 'tee', catalogVersion: 'v1' }, { id: 'model-b', privacy: 'tee', catalogVersion: 'v1' }], tasks: [{ id: 'research-1', kind: 'research', version: '1' }],
    rows: [row('model-a', 'research-1'), row('model-b', 'research-1')]
  }, null, 2)}\n`;
}

test('comparisons: one an older build saved with mode "run" is migrated as a rerun comparison, listed by the store, and a second migration changes nothing', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const id = '2026-11-08T00-28-34-953Z';
    const editor = await legacyEditor(storage, root, { rawEvals: [{ name: id, text: olderModeRun(id) }] });
    const store = threadsOf(root, editor.secrets);
    const first = await migrate(root, editor, store);
    assert.equal(first.comparisons, 1);
    assert.equal(first.skipped, 0);
    const home = stateHomeFor(root);
    const listed = await new ComparisonStore(home.paths.comparisons).list();
    assert.deepEqual(listed.map((run) => [run.id, run.mode, run.rows.length]), [[id, 'rerun', 2]]);
    assert.match(await readFile(path.join(home.paths.comparisons, `${id}.json`), 'utf8'), /"mode": "rerun"/);
    const state = await hashTree(home.paths.comparisons);
    const second = await migrate(root, editor, store);
    assert.equal(second.comparisons, 0);
    assert.equal(second.skipped, 0);
    assert.equal(await hashTree(home.paths.comparisons), state);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

const spendLines = {
  a: [
    { t: 'e', id: 'e1', v: 1, w: 'w1', at: Date.UTC(2026, 10, 3, 12), rid: 'inf-1', model: 'model-a', path: '/v1/chat', kind: 'main', proj: SCOPE, st: 'open', est: 2_000_000 },
    { t: 'e', id: 'e1', v: 2, end: Date.UTC(2026, 10, 3, 12, 1), st: 'completed', in: 100, out: 50, est: 3_000_000 },
    { t: 'a', rid: 'inf-1', nano: 2_500_000, how: 'billing', at: Date.UTC(2026, 10, 4) },
    { t: 'e', id: 'e2', v: 1, w: 'w1', at: Date.UTC(2026, 10, 3, 13), rid: 'inf-other', model: 'model-z', path: '/v1/chat', kind: 'main', proj: OTHER_SCOPE, st: 'open', est: 9_000_000 },
    { t: 'e', id: 'e2', v: 2, end: Date.UTC(2026, 10, 3, 13, 1), st: 'completed', est: 9_000_000 },
    { t: 'a', rid: 'inf-other', nano: 9_000_000, how: 'billing', at: Date.UTC(2026, 10, 4) },
    { t: 'e', id: 'e3', v: 1, w: 'w1', at: Date.UTC(2026, 10, 5), model: 'model-b', path: '/v1/chat', kind: 'summary', proj: SCOPE, st: 'completed', est: 1_000_000 },
    { t: 'e', id: 'e5', v: 2, end: Date.UTC(2026, 10, 1, 0, 1), st: 'completed', est: 600_000 }
  ],
  aOctober: [{ t: 'e', id: 'e5', v: 1, w: 'w1', at: Date.UTC(2026, 9, 31, 23, 59), rid: 'inf-5', model: 'model-a', path: '/v1/chat', kind: 'main', proj: SCOPE, st: 'open', est: 500_000 }],
  b: [
    { t: 'e', id: 'e4', v: 1, w: 'w2', at: Date.UTC(2026, 10, 6), rid: 'inf-4', model: 'model-a', path: '/v1/chat', kind: 'main', proj: SCOPE, st: 'open', est: 4_000_000 },
    { t: 'e', id: 'e4', v: 2, end: Date.UTC(2026, 10, 6, 0, 1), st: 'completed', est: 4_100_000 },
    { t: 'a', rid: 'inf-4', nano: 4_200_000, how: 'billing', at: Date.UTC(2026, 10, 7) }
  ]
};

test('spend: this project\'s entries are mirrored with every later version of them, never another project\'s, and the history adds up across editors', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const a = await legacyEditor(path.join(storage, 'a'), root, { spend: [{ identity: 'idA', month: '2026-11', lines: spendLines.a }, { identity: 'idA', month: '2026-10', lines: spendLines.aOctober }] });
    const b = await legacyEditor(path.join(storage, 'b'), root, { spend: [{ identity: 'idB', month: '2026-11', lines: spendLines.b }] });
    const beforeA = await hashTree(a.dir);
    const store = threadsOf(root);
    const first = await migrate(root, a, store, 'edA.1', {}, SCOPE);
    assert.equal(first.spendLines, 6);
    assert.equal(await hashTree(a.dir), beforeA);
    const home = stateHomeFor(root);
    const november = (await readFile(path.join(home.paths.spend, '2026-11.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { t: string; id?: string; v?: number; rid?: string });
    assert.deepEqual(november.filter((line) => line.id === 'e1').map((line) => line.v).sort(), [1, 2], 'the later version of an entry has no project tag of its own and is kept with its first');
    assert.equal(november.some((line) => line.id === 'e2' || line.rid === 'inf-other'), false, 'another project\'s spend is not copied');
    assert.ok(november.some((line) => line.t === 'a' && line.rid === 'inf-1'));
    assert.deepEqual((await readdir(home.paths.spend)).sort(), ['2026-10.jsonl', '2026-11.jsonl']);

    const second = await migrate(root, b, store, 'edB.1', {}, SCOPE);
    assert.equal(second.spendLines, 3);
    const months = await readProjectSpend(home, Date.UTC(2026, 10, 20));
    assert.deepEqual(months.map((month) => month.month), ['2026-11', '2026-10']);
    const nov = months[0];
    assert.equal(nov.requests, 3, 'e1, e3 and e4');
    assert.ok(Math.abs(nov.confirmedUsd - 0.0067) < 1e-9, `confirmed ${nov.confirmedUsd}`);
    assert.ok(Math.abs(nov.estimatedUsd - 0.001) < 1e-9, `estimated ${nov.estimatedUsd}`);
    assert.deepEqual(nov.byModel.map((model) => model.model).sort(), ['model-a', 'model-b']);
    const oct = months[1];
    assert.equal(oct.requests, 1);
    assert.ok(Math.abs(oct.estimatedUsd - 0.0006) < 1e-9, 'an entry that began in October and ended in November counts once, with its final estimate');

    const text = formatProjectSpend(months);
    assert.match(text, /Project spend history/);
    assert.match(text, /2026-11/);
    assert.match(text, /model-a/);
    assert.equal(formatProjectSpend([]), '');

    // Mirroring again, after a run, from only the newest months finds nothing new and writes nothing.
    const spendTree = await hashTree(home.paths.spend);
    assert.equal(await mirrorProjectSpend({ ledgerRoot: path.join(a.dir, 'spend'), projectScopeId: SCOPE, home, recentMonths: 2 }), 0);
    assert.equal(await hashTree(home.paths.spend), spendTree);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('Team Mode, cyber, the runtime and the emergency stop in the editor storage are left alone and not migrated', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const editor = await legacyEditor(storage, root, { key: randomBytes(32), transcripts: [thread(1)], decoys: true });
    const before = await hashTree(storage);
    await migrate(root, editor, threadsOf(root, editor.secrets));
    assert.equal(await hashTree(storage), before);
    const names = await readdir(stateHomeFor(root).dir);
    for (const name of ['team', 'teams', 'cyber', 'gsd', 'emergency-stop.json']) assert.equal(names.includes(name), false, `${name} is not copied`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('migrating editor A then B gives the same state as B then A', async () => {
  const build = async (storage: string, root: string): Promise<[LegacyEditor, LegacyEditor]> => [
    await legacyEditor(path.join(storage, 'a'), root, {
      key: randomBytes(32), transcripts: [thread(1), thread(2), { id: 'conv-both-have', title: 'Both', updatedAt: minute(7), messages: thread(7).messages }],
      markers: [{ conversationId: 'conv-mig-0001', runId: 'run-1793000000021-aaaaaa', activeAt: minute(11) }],
      evals: [savedRunFixture('2026-11-12T09-30-00-000Z')],
      spend: [{ identity: 'idA', month: '2026-11', lines: spendLines.a }, { identity: 'idA', month: '2026-10', lines: spendLines.aOctober }]
    }),
    await legacyEditor(path.join(storage, 'b'), root, {
      key: randomBytes(32), transcripts: [thread(3), { id: 'conv-both-have', title: 'Both', updatedAt: minute(9), messages: [...thread(7).messages, { role: 'user', content: 'More' }, { role: 'assistant', content: 'More answered' }] }],
      markers: [{ conversationId: 'conv-mig-0001', runId: 'run-1793000000022-bbbbbb', activeAt: minute(12) }],
      evals: [savedRunFixture('2026-11-06T09-30-00-000Z')],
      spend: [{ identity: 'idB', month: '2026-11', lines: spendLines.b }]
    })
  ];
  const results: unknown[] = [];
  for (const order of [['a', 'b'], ['b', 'a']] as const) {
    const root = await tempProject();
    const storage = await tempStorage();
    try {
      const editors = await build(storage, root);
      const byName = { a: editors[0], b: editors[1] };
      for (const name of order) {
        const editor = byName[name];
        await migrate(root, editor, threadsOf(root, editor.secrets, name === 'a' ? 'edA.1' : 'edB.1'), name === 'a' ? 'edA.1' : 'edB.1', {}, SCOPE);
      }
      results.push(await logical(root));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal((results[0] as { threads: unknown[] }).threads.length, 4);
});

test('a crash after the first two conversations, then a rerun, ends equal to an uninterrupted run', async () => {
  const build = (storage: string, root: string): Promise<LegacyEditor> => legacyEditor(storage, root, {
    key: randomBytes(32), transcripts: [thread(1), thread(2), thread(3), thread(4)],
    markers: [{ conversationId: 'conv-mig-0001', runId: 'run-1793000000031-aaaaaa', activeAt: minute(11) }],
    spend: [{ identity: 'idA', month: '2026-11', lines: spendLines.a }]
  });
  const results: unknown[] = [];
  for (const crash of [false, true]) {
    const root = await tempProject();
    const storage = await tempStorage();
    try {
      const editor = await build(storage, root);
      if (crash) {
        let handled = 0;
        await assert.rejects(migrate(root, editor, threadsOf(root, editor.secrets), 'edA.1', { afterItem: ({ kind }) => { if (kind === 'thread' && ++handled === 2) throw new Error('the editor was closed'); } }, SCOPE), /closed/);
        assert.equal((await threadsOf(root).list()).length, 2, 'two conversations were merged before the crash');
      }
      const report = await migrate(root, editor, threadsOf(root, editor.secrets), 'edA.1', {}, SCOPE);
      assert.equal(report.threads.copied + report.threads.unchanged, 4);
      results.push(await logical(root));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }
  assert.deepEqual(results[0], results[1]);
});

test('after migration the 5-live rule applies: eight conversations leave five live and three archived, all eight listed, and a rerun brings none back', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const editor = await legacyEditor(storage, root, { key: randomBytes(32), transcripts: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => thread(n)) });
    const store = threadsOf(root, editor.secrets);
    const report = await migrate(root, editor, store, 'edA.1', { liveConversations: 5 });
    assert.equal(report.threads.copied, 8);
    assert.equal(report.archived, 3);
    const index = await store.index();
    assert.equal(index.length, 8);
    assert.deepEqual(index.filter((item) => item.state === 'archived').map((item) => item.id).sort(), [thread(1).id, thread(2).id, thread(3).id]);
    assert.equal(index.find((item) => item.id === thread(1).id)?.title, 'Thread 1', 'an archived thread keeps its title');

    const again = await migrate(root, editor, store, 'edA.1', { liveConversations: 5 });
    assert.equal(changesIn(again), 0);
    assert.equal(again.threads.unchanged, 8);
    assert.equal((await store.index()).filter((item) => item.state === 'archived').length, 3);

    // A conversation open in a tab stays live whatever its age.
    const other = await tempProject();
    try {
      const store2 = threadsOf(other, editor.secrets);
      const editor2 = await legacyEditor(path.join(storage, 'two'), other, { key: randomBytes(32), transcripts: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => thread(n)) });
      const kept = await migrate(other, editor2, store2, 'edA.1', { liveConversations: 5, protectedIds: () => [thread(1).id] });
      assert.equal(kept.archived, 2, 'the oldest is protected, so only the next two go');
      assert.equal((await store2.index()).find((item) => item.id === thread(1).id)?.state, 'live');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('malformed files are skipped and counted, and never stop the rest from migrating', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const editor = await legacyEditor(storage, root, {
      key: randomBytes(32), transcripts: [thread(1)],
      rawTranscripts: [
        { name: 'conv-not-json-two', text: 'not json at all' },
        { name: 'conv-empty-chat', text: JSON.stringify({ id: 'conv-empty-chat', title: 'Empty', model: 'm', updatedAt: AT, turns: 0, messages: [{ role: 'system', content: 'x' }] }) },
        { name: 'conv-bad-time-x', text: JSON.stringify({ id: 'conv-bad-time-x', title: 'Bad', model: 'm', updatedAt: 'yesterday', turns: 1, messages: conversation() }) },
        { name: 'conv-bad-message', text: JSON.stringify({ id: 'conv-bad-message', title: 'Bad', model: 'm', updatedAt: AT, turns: 1, messages: [{ role: 'user' }] }) }
      ]
    });
    const report = await migrate(root, editor, threadsOf(root, editor.secrets));
    assert.equal(report.threads.copied, 1);
    assert.equal(report.threads.skipped, 4);
    assert.equal(report.threads.locked, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('an archived conversation is not brought back by a second migration, and entries it lacks are added to its archive', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const editor = await legacyEditor(storage, root, { key: randomBytes(32), transcripts: [1, 2, 3].map((n) => thread(n)) });
    const store = threadsOf(root, editor.secrets);
    await migrate(root, editor, store, 'edA.1', { liveConversations: 1 });
    assert.deepEqual((await store.index()).filter((item) => item.state === 'archived').map((item) => item.id).sort(), [thread(1).id, thread(2).id]);
    const again = await migrate(root, editor, store, 'edA.1', { liveConversations: 1 });
    assert.equal(changesIn(again), 0);
    assert.equal((await store.index()).filter((item) => item.state === 'archived').length, 2);

    // The same conversation, longer, in another editor: the archive gains the missing entries and stays archived.
    const longer = { ...thread(1), updatedAt: minute(1), messages: [...thread(1).messages, { role: 'user' as const, content: 'Later question' }, { role: 'assistant' as const, content: 'Later answer' }] };
    const other = await legacyEditor(path.join(storage, 'other'), root, { key: randomBytes(32), transcripts: [longer] });
    const merged = await migrate(root, other, store, 'edB.1', { liveConversations: 1 });
    assert.equal(merged.threads.merged, 1);
    const item = (await store.index()).find((entry) => entry.id === thread(1).id);
    assert.equal(item?.state, 'archived');
    assert.equal((await store.entries(thread(1).id)).length, 4, 'opening it brings every entry back, the added ones too');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

// ---- plan 10, task 3: when it runs ------------------------------------------------------------------------------------------------------------

function fakeContext(storage: string, secrets: MemorySecrets): { globalStorageUri: { fsPath: string }; secrets: MemorySecrets; globalState: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> } } {
  const values = new Map<string, unknown>();
  return { globalStorageUri: { fsPath: storage }, secrets, globalState: { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, value); } } };
}

test('ensureMigrated runs once per project, logs only counts, and an editor with nothing to migrate leaves the project untouched', async () => {
  const root = await tempProject();
  const empty = await tempProject();
  const storage = await tempStorage();
  try {
    const key = randomBytes(32);
    const editor = await legacyEditor(storage, root, { key, transcripts: [{ id: 'conv-secret-title', title: 'SENTINEL-TITLE-DO-NOT-LOG', updatedAt: AT, messages: [{ role: 'user', content: 'SENTINEL-TEXT-DO-NOT-LOG' }, { role: 'assistant', content: 'ok' }] }] });
    const lines: string[] = [];
    configureMigration(fakeContext(storage, editor.secrets), undefined, { log: (line) => lines.push(line), liveConversations: () => 5 });

    assert.equal(await stateHomeFor(root).exists(), false, 'configuring reads and writes nothing');
    const first = ensureMigrated(root);
    assert.equal(ensureMigrated(root), first, 'the second ask gets the same run');
    const report = await first;
    assert.equal(report?.threads.copied, 1);
    assert.equal(await ensureMigrated(root), report);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /conversations 1 copied/);
    assert.equal(lines.join('\n').includes('SENTINEL'), false);
    assert.equal(lines.join('\n').includes('conv-secret-title'), false);

    // A project this editor holds nothing for: no state home appears.
    assert.equal((await ensureMigrated(empty))?.threads.copied, 0);
    assert.equal(await stateHomeFor(empty).exists(), false);
    assert.equal(lines.length, 1, 'a run that changed nothing logs nothing');
  } finally {
    configureMigration(fakeContext(storage, new MemorySecrets()));
    await rm(root, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('an editor that never had an old key does not get one made for it, and a locked conversation is tried again after a new start', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    const sealed = await legacyEditor(storage, root, { key: randomBytes(32), transcripts: [{ id: 'conv-sealed-here', updatedAt: AT, messages: conversation() }] });
    const keyless = new MemorySecrets();
    configureMigration(fakeContext(storage, keyless));
    const first = await ensureMigrated(root);
    assert.equal(first?.threads.locked, 1);
    assert.equal(keyless.values.has('nearAi.transcripts.key'), false, 'no key was created to look for what a key cannot open');
    // A new extension host (configure again) with the key back migrates it.
    configureMigration(fakeContext(storage, sealed.secrets));
    assert.equal((await ensureMigrated(root))?.threads.copied, 1);
  } finally {
    configureMigration(fakeContext(storage, new MemorySecrets()));
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

test('the run report gets a project spend history section from every editor, and a project with no state home gets none', async () => {
  const root = await tempProject();
  const storage = await tempStorage();
  try {
    assert.equal(await projectSpendSection(root), '', 'no state home: the report is unchanged');
    const a = await legacyEditor(path.join(storage, 'a'), root, { spend: [{ identity: 'idA', month: '2026-11', lines: spendLines.a }] });
    const b = await legacyEditor(path.join(storage, 'b'), root, { spend: [{ identity: 'idB', month: '2026-11', lines: spendLines.b }] });
    const home = stateHomeFor(root);
    await home.ensure();
    assert.equal(await projectSpendSection(root), '', 'a state home with no spend: unchanged');
    await mirrorProjectSpend({ ledgerRoot: path.join(a.dir, 'spend'), projectScopeId: SCOPE, home });
    await mirrorProjectSpend({ ledgerRoot: path.join(b.dir, 'spend'), projectScopeId: SCOPE, home });
    const section = await projectSpendSection(root, Date.UTC(2026, 10, 20));
    assert.match(section, /^## Project spend history/);
    assert.match(section, /3 requests/, 'both editors\' requests are in it');
    assert.match(section, /daily spend limit still counts only this editor/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});
