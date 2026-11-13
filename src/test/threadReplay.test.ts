import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { entryId, TOOL_RESULT_CAP_BYTES, threadLines, type ThreadEntry, type ThreadRole } from '../domain/state/threadEntries';
import { batchView, entriesToView, OTHER_CONTINUATION_LABEL, PARTIAL_HISTORY, PARTIAL_HISTORY_NOTE, type ViewItem } from '../domain/state/threadView';
import { AgentConversation } from '../services/agentSession';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { ConversationLog } from '../services/conversations';
import type { AgentMessage, ToolCall } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import type { Transcript } from '../services/transcripts';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 06 (SYNC-01, D-07, D-08, D-12): a reopened thread shows every entry of its log, tool steps as cards with their output on demand,
// long threads in batches, a second continuation labelled, and the history list built from the index.

const THREAD = 'conv-replay-0001';
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A chain of entries after `parent`, one second apart from `start`, written by `writer`. */
function chain(parent: ThreadEntry | undefined, writer: string, start: number, bodies: Array<[ThreadRole, unknown]>, thread = THREAD): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  let previous: string | null = parent ? parent.id : null;
  bodies.forEach(([role, body], index) => {
    const entry: ThreadEntry = { id: entryId(previous, role, body), thread, parent: previous, at: new Date(start + index * 1000).toISOString(), writer, role, body };
    out.push(entry);
    previous = entry.id;
  });
  return out;
}

function storeFor(root: string, secrets = new MemorySecrets(), writer = 'edA.1'): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer });
}

const stepBodies: Array<[ThreadRole, unknown]> = [
  ['user', { text: 'Read both notes' }],
  ['assistant', { text: 'Reading them.' }],
  ['tool-call', { callId: 'c1', name: 'Read', args: { file_path: 'a.md' } }],
  ['tool-call', { callId: 'c2', name: 'Read', args: { file_path: 'b.md' } }],
  ['tool-result', { callId: 'c1', output: 'contents of a' }],
  ['tool-result', { callId: 'c2', output: 'contents of b' }],
  ['assistant', { text: 'Both notes are short.' }]
];

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------

test('a thread with tool steps maps to user, assistant and one collapsed card per tool step, naming the tool and its arguments', () => {
  const entries = chain(undefined, 'edA.1', T0, stepBodies);
  const items = entriesToView(threadLines(entries));
  assert.deepEqual(items.map((item) => item.kind), ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.deepEqual(items[0], { kind: 'user', text: 'Read both notes' });
  const [first, second] = [items[2], items[3]] as Array<Extract<ViewItem, { kind: 'tool' }>>;
  assert.equal(first.name, 'Read');
  assert.match(first.args, /a\.md/);
  assert.equal(first.entryId, entries[2].id, 'the card is asked for by the id of its tool-call entry');
  assert.equal(first.ok, true);
  assert.match(second.args, /b\.md/);
  assert.equal(second.ok, true);
  assert.ok(!('output' in first), 'the card carries no output; it loads when the card is opened');
});

test('a tool call whose result is not stored shows as a failed card, and a result whose call has not arrived is still shown', () => {
  const callOnly = chain(undefined, 'edA.1', T0, [['user', { text: 'go' }], ['tool-call', { callId: 'x', name: 'Bash', args: { command: 'ls' } }]]);
  const items = entriesToView(threadLines(callOnly));
  assert.equal((items[1] as Extract<ViewItem, { kind: 'tool' }>).ok, false);
  const orphan = chain(undefined, 'edA.1', T0, [['user', { text: 'go' }], ['tool-result', { callId: 'gone', output: 'late result' }]]);
  assert.equal(entriesToView(threadLines(orphan)).filter((item) => item.kind === 'tool').length, 1, 'nothing is hidden');
});

test('reopening a thread of a ThreadStore returns items whose user texts equal what was typed', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const messages: AgentMessage[] = [{ role: 'system', content: 'You are an agent.' }];
    const asked: string[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      asked.push(`Question ${turn}`);
      messages.push({ role: 'user', content: `Question ${turn}` }, { role: 'assistant', content: null, tool_calls: [call(`c${turn}`, 'Read', { file_path: `f${turn}.md` })] }, { role: 'tool', tool_call_id: `c${turn}`, content: `result ${turn}` }, { role: 'assistant', content: `Answer ${turn}` });
    }
    const transcript: Transcript = { id: THREAD, title: 'Three questions', model: 'm', updatedAt: new Date().toISOString(), turns: 3, messages };
    await store.captureTranscript(transcript, new Map(), new WeakSet());
    await store.save(transcript);
    const reopened = new AgentConversation(root, () => undefined, stateHomeFor(root).paths.checkpoints, undefined, storeFor(root, new MemorySecrets(), 'edB.1'));
    const view = await reopened.restore(THREAD);
    assert.ok(view && !Array.isArray(view), 'a thread store answers with items');
    const items = (view as { items: ViewItem[] }).items;
    assert.deepEqual(items.filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text), asked);
    assert.equal(items.filter((item) => item.kind === 'tool').length, 3, 'each tool step is a card, not a count');
    assert.deepEqual(items.map((item) => item.kind).slice(0, 4), ['user', 'tool', 'assistant', 'user']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Task 2: output on open, batches, divider, the marker ------------------------------------------------------------------------------

test('a thread of 5 000 entries reaches the view in 25 batches of at most 200, and every entry is rendered', () => {
  const bodies: Array<[ThreadRole, unknown]> = Array.from({ length: 5_000 }, (_, index) => index % 2 === 0 ? ['user', { text: `typed ${index}` }] : ['assistant', { text: `reply ${index}` }]);
  const entries = chain(undefined, 'edA.1', T0, bodies);
  const items = entriesToView(threadLines(entries));
  assert.equal(items.length, 5_000, 'the rendered count equals the entry count: no cut-off, no "show last N"');
  const batches = batchView(items);
  assert.equal(batches.length, 25);
  assert.ok(batches.every((batch) => batch.length <= 200));
  assert.deepEqual(batches.flat(), items, 'concatenated, the batches equal the input exactly');
  assert.equal((items[0] as { text: string }).text, 'typed 0');
  assert.equal((items[4_999] as { text: string }).text, 'reply 4999', 'the newest entry is there too');
  assert.deepEqual(batchView([], 200), []);
});

test('a thread continued on two computers shows its main line, then a labelled divider, then the other continuation, with every entry once', () => {
  const shared = chain(undefined, 'edShared.1', T0, [['user', { text: 'start' }], ['assistant', { text: 'hello' }]]);
  const tip = shared[shared.length - 1];
  const a = chain(tip, 'edAAAA.1', T0 + 60_000, [['user', { text: 'A asks' }], ['assistant', { text: 'A answer' }]]);
  const b = chain(tip, 'edBBBB.1', T0 + 120_000, [['user', { text: 'B asks' }], ['tool-call', { callId: 'k', name: 'Bash', args: { command: 'ls' } }], ['tool-result', { callId: 'k', output: 'listing' }], ['assistant', { text: 'B answer' }]]);
  const items = entriesToView(threadLines([...shared, ...a, ...b]));
  assert.deepEqual(items.map((item) => item.kind), ['user', 'assistant', 'user', 'tool', 'assistant', 'divider', 'user', 'assistant']);
  assert.equal(items.filter((item) => item.kind === 'divider').length, 1);
  assert.deepEqual(items[5], { kind: 'divider', text: OTHER_CONTINUATION_LABEL });
  assert.equal(OTHER_CONTINUATION_LABEL, 'Also continued on another computer');
  const texts = items.filter((item): item is Extract<ViewItem, { text: string }> => 'text' in item).map((item) => item.text);
  for (const wanted of ['start', 'hello', 'A asks', 'A answer', 'B asks', 'B answer']) assert.equal(texts.filter((text) => text === wanted).length, 1, `${wanted} appears once`);
  // 7 entries on the main line and 2 on the branch, all shown (the call and its result are one card).
  assert.equal(items.length - 1, shared.length + a.length + b.length - 1);
});

test('D-12: a tool result shortened by the cap shows how much was not stored, and nothing else is marked', () => {
  const entries = chain(undefined, 'edA.1', T0, [
    ['user', { text: 'big' }],
    ['tool-call', { callId: 'a', name: 'Read', args: { file_path: 'huge.log' } }],
    ['tool-result', { callId: 'a', output: 'x'.repeat(10), shortenedBytes: 3_145_728 }],
    ['tool-call', { callId: 'b', name: 'Read', args: { file_path: 'mid.log' } }],
    ['tool-result', { callId: 'b', output: 'y', shortenedBytes: 1_572_864 }],
    ['tool-call', { callId: 'c', name: 'Read', args: { file_path: 'small.log' } }],
    ['tool-result', { callId: 'c', output: 'z' }]
  ]);
  const tools = entriesToView(threadLines(entries)).filter((item): item is Extract<ViewItem, { kind: 'tool' }> => item.kind === 'tool');
  assert.equal(tools[0].shortenedBytes, 3_145_728);
  assert.match(tools[0].note ?? '', /output shortened, 3 MB/);
  assert.equal(tools[1].note, 'output shortened, 1.5 MB');
  assert.equal(tools[2].note, undefined);
  assert.ok(TOOL_RESULT_CAP_BYTES < 3_145_728);
});

test('a thread migrated with partial history starts with the note that earlier messages cannot be restored', () => {
  const entries = chain(undefined, 'edA.1', T0, [['user', { text: 'later question' }], ['assistant', { text: 'later answer' }]]);
  const items = entriesToView(threadLines(entries), { history: PARTIAL_HISTORY });
  assert.deepEqual(items[0], { kind: 'notice', text: PARTIAL_HISTORY_NOTE });
  assert.equal(PARTIAL_HISTORY_NOTE, 'Earlier messages of this chat were summarised before this version and cannot be restored');
  assert.equal(items.length, 3);
  assert.equal(entriesToView(threadLines(entries), {}).length, 2, 'no note for an ordinary thread');
});

test('the tool-output request is accepted only with exactly its three keys and well-formed ids', () => {
  const entry = entryId(null, 'tool-call', { callId: 'q' });
  assert.equal(entry.length, 26);
  const good = { type: 'thread-tool-output', conversationId: 'conv-abc123', entryId: entry };
  assert.deepEqual(parseChatWebviewMessage(good), good);
  assert.equal(parseChatWebviewMessage({ ...good, extra: 1 }), undefined, 'an extra key');
  assert.equal(parseChatWebviewMessage({ ...good, conversationId: 'conv-../etc' }), undefined, 'a bad conversation id');
  assert.equal(parseChatWebviewMessage({ ...good, conversationId: undefined }), undefined, 'no conversation id');
  assert.equal(parseChatWebviewMessage({ type: 'thread-tool-output', conversationId: 'conv-abc123' }), undefined, 'no entry id');
  for (const bad of ['', 'short', entry.toUpperCase(), `${entry}0`, `${entry.slice(0, 25)}!`, 7]) assert.equal(parseChatWebviewMessage({ ...good, entryId: bad }), undefined, `entry id ${String(bad)}`);
});

test('ThreadStore.toolOutput returns the stored output of a step, and nothing for an unknown entry', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const entries = chain(undefined, 'edA.1', T0, [
      ['user', { text: 'two calls' }],
      ['tool-call', { callId: 'same', name: 'Read', args: { file_path: 'one.md' } }],
      ['tool-result', { callId: 'same', output: 'first output' }],
      ['assistant', { text: 'next' }],
      ['tool-call', { callId: 'same', name: 'Read', args: { file_path: 'two.md' } }],
      ['tool-result', { callId: 'same', output: 'second output', shortenedBytes: 3_145_728 }]
    ]);
    await store.appendEntries(THREAD, entries);
    assert.equal(await store.toolOutput(THREAD, entries[1].id), 'first output', 'a call id a provider reused answers with the nearest result');
    assert.equal(await store.toolOutput(THREAD, entries[4].id), 'second output');
    assert.equal(await store.toolOutput(THREAD, entries[2].id), 'first output', 'the result entry itself works too');
    assert.equal(await store.toolOutput(THREAD, entries[0].id), undefined, 'a user entry has no output');
    assert.equal(await store.toolOutput(THREAD, 'zzzzzzzzzzzzzzzzzzzzzzzzzz'), undefined);
    assert.equal(await store.toolOutput('conv-not-there-1', entries[1].id), undefined);
    assert.equal(await storeFor(root, new MemorySecrets(), 'edOther.1').toolOutput(THREAD, entries[1].id), 'first output', 'another editor on the host reads it too');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the chat page renders stored output as text, never as markup, and asks for it only when a card is opened', async () => {
  const script = await readFile(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const begin = script.indexOf('// history:begin');
  const end = script.indexOf('// history:end');
  assert.ok(begin > 0 && end > begin, 'the history rendering is delimited');
  const section = script.slice(begin, end);
  assert.ok(!/innerHTML/.test(section), 'T-27-25: no innerHTML in the history rendering');
  assert.match(section, /textContent/);
  assert.match(section, /thread-tool-output/);
  assert.match(section, /'toggle'/, 'the request is made when the card is opened');
  assert.match(section, /requestAnimationFrame/, 'T-27-27: rendered in slices per animation frame');
  assert.match(section, /HISTORY_SLICE = 50/);
  const css = await readFile(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(css, /content-visibility:\s*auto/);
});

test('a reopened thread stays whole in the conversation log however long the live output grows', () => {
  const log = new ConversationLog(40);
  for (let part = 1; part <= 3; part += 1) log.add({ type: 'transcript', items: [{ kind: 'user', text: `part ${part}` }], part, of: 3 });
  for (let index = 0; index < 200; index += 1) log.add({ type: 'tool-start', callId: `t${index}`, title: `step ${index}` });
  const replayed = log.replay(new Map(), new Map());
  assert.equal(replayed.filter((message) => message.type === 'transcript').length, 3, 'no part of the history is trimmed away');
  assert.equal(replayed.at(0)?.type, 'notice', 'the live output that was trimmed says so');
});

