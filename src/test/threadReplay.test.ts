import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { entryId, threadLines, type ThreadEntry, type ThreadRole } from '../domain/state/threadEntries';
import { entriesToView, type ViewItem } from '../domain/state/threadView';
import { AgentConversation } from '../services/agentSession';
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

