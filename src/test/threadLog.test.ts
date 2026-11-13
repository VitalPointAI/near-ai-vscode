import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compactConversation, trimOldToolResults } from '../agent/context';
import { DEFAULT_RULES } from '../agent/permissions';
import { contentKey, COMPACTION_ACK, messagesToEntries } from '../domain/state/threadCapture';
import { AgentConversation, type AgentTurnRequest, type GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { StateKeys, stateKeysFor } from '../services/stateKeys';
import { ThreadStore, threadStoreFor } from '../services/threadStore';
import { TranscriptStore, type Transcript } from '../services/transcripts';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 05 (SYNC-01, D-07): every thread keeps its full conversation in an append-only log in the state home, captured before the model's
// context is trimmed or compacted. Each test works on a temporary project folder; a second editor is a second store over the same folder.

const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const THREAD = 'conv-thread-0001';

function storeFor(root: string, secrets = new MemorySecrets(), writer = 'edA.1'): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer });
}

function transcriptOf(messages: AgentMessage[], id = THREAD, display: Map<string, string> = new Map()): Transcript {
  return { id, title: 'A long conversation', model: 'm', updatedAt: new Date().toISOString(), turns: messages.filter((message) => message.role === 'user').length, messages, display: [...display.entries()] };
}

/** Twelve user turns, each with a tool call and a large result, then the assistant's answer. The model saw an expanded prompt on odd turns. */
function longConversation(turns = 12): { messages: AgentMessage[]; display: Map<string, string> } {
  const messages: AgentMessage[] = [{ role: 'system', content: 'You are an agent.' }];
  const display = new Map<string, string>();
  for (let turn = 1; turn <= turns; turn += 1) {
    const typed = `Question ${turn}`;
    const content = turn % 2 === 1 ? `<project-memory>\nnotes\n</project-memory>\n\n${typed}` : typed;
    display.set(contentKey(content), typed);
    messages.push({ role: 'user', content }, { role: 'assistant', content: null, tool_calls: [call(`c${turn}`, 'Read', { file_path: `f${turn}.md` })] }, { role: 'tool', tool_call_id: `c${turn}`, content: `${'x'.repeat(5_000)} result ${turn}` }, { role: 'assistant', content: `Answer ${turn}` });
  }
  return { messages, display };
}

const summarizer = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { yield { type: 'done', message: { role: 'assistant', content: 'SUMMARY of the first part' }, finishReason: 'stop', usage }; } };

function userTexts(entries: Array<{ role: string; body: unknown }>): string[] {
  return entries.filter((entry) => entry.role === 'user').map((entry) => (entry.body as { text: string }).text);
}

test('a conversation compacted mid-run keeps every message the person typed, in order, in the thread log', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const logged = new WeakSet<AgentMessage>();
    const { messages, display } = longConversation();
    // The run captures before each turn, as beforeTurn does: the log is written turn by turn while the list grows.
    for (let turn = 1; turn <= 12; turn += 1) await store.captureTranscript(transcriptOf(messages.slice(0, 1 + turn * 4), THREAD, display), display, logged);
    // The context is then managed: old tool output is trimmed and everything before the recent messages is summarised.
    const trimmed = trimOldToolResults(messages, 2, 2);
    const compacted = await compactConversation(summarizer, 'm', trimmed, new AbortController().signal, 4);
    assert.ok(compacted, 'the conversation compacts');
    assert.ok(compacted.length < messages.length / 2, 'the working list is much shorter than the conversation');
    assert.ok(compacted.some((message) => message.role === 'user' && message.content.startsWith('<conversation-summary>')));
    for (const message of compacted) logged.add(message);
    await store.captureTranscript(transcriptOf(compacted, THREAD, display), display, logged);

    const entries = await store.entries(THREAD);
    const expected = Array.from({ length: 12 }, (_, index) => `Question ${index + 1}`);
    assert.deepEqual(userTexts(entries).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })), expected, 'all twelve typed messages');
    const main = (await store.lines(THREAD)).main;
    assert.deepEqual(userTexts(main), expected, 'in the order they were typed');
    assert.equal(main.filter((entry) => entry.role === 'assistant').length, 12, 'every assistant reply');
    assert.equal(main.filter((entry) => entry.role === 'tool-call').length, 12, 'every tool call');
    const results = main.filter((entry) => entry.role === 'tool-result').map((entry) => entry.body as { output: string; shortenedBytes?: number });
    assert.equal(results.length, 12);
    assert.ok(results.every((result) => result.output.length > 5_000 && result.shortenedBytes === undefined), 'tool results are stored untrimmed');
    const first = main.find((entry) => entry.role === 'user')!.body as { text: string; modelText?: string };
    assert.equal(first.text, 'Question 1');
    assert.match(first.modelText ?? '', /^<project-memory>/, 'what the model saw is kept beside what the person typed');
    assert.equal((main.filter((entry) => entry.role === 'user')[1].body as { modelText?: string }).modelText, undefined, 'and only when it differs');
    const text = JSON.stringify(entries.map((entry) => entry.body));
    assert.doesNotMatch(text, /<conversation-summary>|SUMMARY of the first part/, 'no summary reaches the log');
    assert.equal(entries.some((entry) => (entry.body as { text?: string }).text === COMPACTION_ACK), false, 'nor the acknowledgement');
    assert.equal(entries.some((entry) => JSON.stringify(entry.body).includes('You are an agent.')), false, 'nor the system prompt');
    assert.doesNotMatch(text, /Older tool output trimmed/, 'nor a trimmed copy');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capturing the same messages again, or the compacted list, appends nothing', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const logged = new WeakSet<AgentMessage>();
    const { messages, display } = longConversation(6);
    await store.captureTranscript(transcriptOf(messages, THREAD, display), display, logged);
    const logFile = path.join(stateHomeFor(root).paths.threads, THREAD, 'log.jsonl');
    const before = { bytes: (await stat(logFile)).size, count: (await store.entries(THREAD)).length };
    await store.captureTranscript(transcriptOf(messages, THREAD, display), display, logged);
    // A second conversation object over the same thread has an empty logged set: the entry ids dedupe, so the log still does not grow.
    await storeFor(root).captureTranscript(transcriptOf(messages, THREAD, display), display, new WeakSet());
    const compacted = (await compactConversation(summarizer, 'm', trimOldToolResults(messages, 2, 2), new AbortController().signal, 4))!;
    for (const message of compacted) logged.add(message);
    await store.captureTranscript(transcriptOf(compacted, THREAD, display), display, logged);
    assert.deepEqual({ bytes: (await stat(logFile)).size, count: (await store.entries(THREAD)).length }, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a compacted conversation reopens with every user turn, from the log, and still continues from its saved context', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    let step = 0;
    const client = {
      async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
        const summary = messages[0]?.content?.startsWith('You compress');
        yield { type: 'done', message: { role: 'assistant', content: summary ? 'SUMMARY so far' : `Answer ${step += 1}` }, finishReason: 'stop', usage };
      },
      async actualCostsUsd() { return undefined; }
    };
    const conversation = new AgentConversation(root, () => undefined, path.join(stateHomeFor(root).paths.checkpoints), undefined, store);
    conversation.compactAtTokens = 1_500;
    const asked: string[] = [];
    for (let turn = 1; turn <= 12; turn += 1) {
      const text = `Question ${turn} ${'detail '.repeat(120)}`;
      asked.push(text);
      const request: AgentTurnRequest = { text, client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES };
      await conversation.send(request);
    }
    const saved = await store.load(conversation.id);
    assert.ok(saved?.messages.some((message) => message.role === 'user' && message.content.startsWith('<conversation-summary>')), 'the run compacted its context');
    assert.ok(saved!.messages.filter((message) => message.role === 'user' && !message.content.startsWith('<conversation-summary>')).length < 12, 'the saved working list lost earlier user messages');

    const reopened = new AgentConversation(root, () => undefined, path.join(stateHomeFor(root).paths.checkpoints), undefined, storeFor(root, new MemorySecrets()));
    // A second editor with no key of its own reads the key file in the state home, so it sees the same conversation.
    const turns = await reopened.restore(conversation.id);
    assert.deepEqual(turns?.filter((turn) => turn.role === 'user').map((turn) => turn.text), asked, 'all twelve typed messages, in order');
    assert.equal(turns?.filter((turn) => turn.role === 'assistant').length, 12);
    assert.equal((await readdir(path.join(stateHomeFor(root).paths.threads, conversation.id))).sort().join(','), 'context.enc,log.jsonl,meta.enc');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the log and the context hold no plaintext on disk', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const { messages, display } = longConversation(3);
    await store.captureTranscript(transcriptOf(messages, THREAD, display), display, new WeakSet());
    await store.save(transcriptOf(messages, THREAD, display));
    const dir = path.join(stateHomeFor(root).paths.threads, THREAD);
    for (const name of await readdir(dir)) assert.doesNotMatch(await readFile(path.join(dir, name), 'utf8'), /Question|Answer|result \d/, `${name} is sealed`);
    assert.equal(((await stat(path.join(dir, 'log.jsonl'))).mode & 0o777), 0o600, 'the log is owner-only');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Task 2: no pruning, locked listing, D-12 and D-13 end to end, context rebuilt after a continuation elsewhere --------------------------

const sampleTranscript = (id: string): Transcript => ({ id, title: `Conversation ${id}`, model: 'm', updatedAt: new Date().toISOString(), turns: 1, messages: [{ role: 'system', content: 's' }, { role: 'user', content: `hello ${id}` }] });

test('saving never deletes a conversation: sixty are kept by the thread store and by the old transcript store', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const old = new TranscriptStore(path.join(root, '.old'), root, async () => Buffer.alloc(32, 7));
    for (let index = 0; index < 60; index += 1) {
      const transcript = sampleTranscript(`conv-${String(index).padStart(6, '0')}`);
      await store.save(transcript);
      await old.save(transcript);
    }
    assert.equal((await store.list()).length, 60);
    assert.equal((await old.list()).length, 60, 'the old store no longer prunes beyond fifty');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a conversation this device cannot open is listed as locked, never dropped', async () => {
  const root = await tempProject();
  try {
    const old = new TranscriptStore(path.join(root, '.old'), root, async () => Buffer.alloc(32, 7));
    await old.save(sampleTranscript('conv-locked-1'));
    await old.save(sampleTranscript('conv-locked-2'));
    const another = await new TranscriptStore(path.join(root, '.old'), root, async () => Buffer.alloc(32, 9)).list();
    assert.deepEqual(another.map((item) => [item.id, item.locked]).sort(), [['conv-locked-1', true], ['conv-locked-2', true]], 'a file sealed with another key is listed as locked');
    assert.deepEqual((await old.list()).map((item) => item.locked), [undefined, undefined], 'with the right key they open');

    const store = storeFor(root);
    await store.save(sampleTranscript('conv-thread-a1'));
    await store.save(sampleTranscript('conv-thread-b2'));
    // The key file is not used and this editor has no copy of the key: the project's chats are locked here.
    const home = stateHomeFor(root);
    const locked = new ThreadStore(home, new StateKeys(home, new MemorySecrets(), () => false), { writer: 'edB.1' });
    const listed = await locked.list();
    assert.deepEqual(listed.map((item) => [item.id, item.locked, item.title]).sort(), [['conv-thread-a1', true, ''], ['conv-thread-b2', true, '']]);
    assert.equal(await locked.load('conv-thread-a1'), undefined, 'and it does not open');
    assert.deepEqual(await locked.entries('conv-thread-a1'), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-12: a 3 MiB tool result is stored shortened with its size, and nothing else is shortened', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const huge = 'y'.repeat(3 * 1024 * 1024);
    const middle = 'z'.repeat(1_500_000);
    const messages: AgentMessage[] = [
      { role: 'system', content: 's' }, { role: 'user', content: 'read two big files' },
      { role: 'assistant', content: null, tool_calls: [call('big', 'Read', { file_path: 'huge.log' }), call('mid', 'Read', { file_path: 'mid.log' })] },
      { role: 'tool', tool_call_id: 'big', content: huge }, { role: 'tool', tool_call_id: 'mid', content: middle }, { role: 'assistant', content: 'Read both.' }
    ];
    await store.captureTranscript(transcriptOf(messages), new Map(), new WeakSet());
    const results = (await store.lines(THREAD)).main.filter((entry) => entry.role === 'tool-result').map((entry) => entry.body as { callId: string; output: string; shortenedBytes?: number });
    const big = results.find((result) => result.callId === 'big')!;
    assert.equal(big.shortenedBytes, 3_145_728);
    assert.equal(Buffer.byteLength(big.output), 2 * 1024 * 1024, 'stored at the 2 MiB cap');
    const mid = results.find((result) => result.callId === 'mid')!;
    assert.equal(mid.output, middle, 'a smaller result is stored whole');
    assert.equal(mid.shortenedBytes, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-13: a sub-agent adds no entries of its own; its report is the lead agent\'s tool result', async () => {
  const root = await tempProject();
  const gsdHome = await mkdtemp(path.join(tmpdir(), 'near-ai-thread-gsd-'));
  try {
    await mkdir(path.join(gsdHome, 'gsd-core'), { recursive: true });
    const gsd: GsdContext = { home: gsdHome, skills: [], agents: [{ name: 'gsd-planner', description: 'Plans', tools: ['Read'], body: 'You are the planner.', file: path.join(gsdHome, 'agents', 'gsd-planner.md') }], shellEnv: {} };
    const parent: Array<{ text?: string; calls?: ToolCall[] }> = [{ calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', description: 'Draft a plan', prompt: 'Plan it carefully.' })] }, { text: 'The planner is done.' }];
    let lead = 0;
    const client = {
      async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
        if (String(messages[0]?.content ?? '').startsWith('You are the planner.')) { yield { type: 'done', message: { role: 'assistant', content: 'PLAN-REPORT ready' }, finishReason: 'stop', usage }; return; }
        const step = parent[lead++] ?? { text: 'done' };
        yield { type: 'done', message: { role: 'assistant', content: step.text ?? null, ...(step.calls ? { tool_calls: step.calls } : {}) }, finishReason: step.calls ? 'tool_calls' : 'stop', usage };
      },
      async actualCostsUsd() { return undefined; }
    };
    const store = storeFor(root);
    const conversation = new AgentConversation(root, () => undefined, stateHomeFor(root).paths.checkpoints, undefined, store);
    await conversation.send({ text: 'Plan the work', client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
    const entries = (await store.lines(conversation.id)).main;
    assert.deepEqual(entries.map((entry) => entry.role), ['user', 'tool-call', 'tool-result', 'assistant'], 'only the lead agent\'s own steps');
    assert.match(String((entries[2].body as { output: string }).output), /PLAN-REPORT ready/, 'the sub-agent\'s report is the lead\'s tool result');
    assert.doesNotMatch(JSON.stringify(entries.map((entry) => entry.body)).replace(/Plan it carefully\./g, ''), /You are the planner/, 'the sub-agent\'s own prompt and turns are not logged');
    assert.equal((await store.entries(conversation.id)).length, 4);
  } finally { await rm(root, { recursive: true, force: true }); await rm(gsdHome, { recursive: true, force: true }); }
});

test('a thread continued on another computer reopens with the continuation in its working context, and nothing is lost', async () => {
  const root = await tempProject();
  try {
    const editorA = storeFor(root, new MemorySecrets(), 'edA.1');
    const { messages, display } = longConversation(4);
    await editorA.captureTranscript(transcriptOf(messages, THREAD, display), display, new WeakSet());
    await editorA.save(transcriptOf(messages, THREAD, display));
    const before = (await editorA.entries(THREAD)).length;

    // Another editor continues the same thread from its tip, after the context was saved.
    const editorB = storeFor(root, new MemorySecrets(), 'edB.1');
    const tip = (await editorB.lines(THREAD)).main.at(-1)!.id;
    const elsewhere: AgentMessage[] = [{ role: 'user', content: 'Asked on the other computer' }, { role: 'assistant', content: 'Answered on the other computer' }];
    await editorB.appendEntries(THREAD, messagesToEntries(elsewhere, new Map(), tip, { thread: THREAD, writer: 'edB.1' }));

    const seen: AgentMessage[][] = [];
    const client = {
      async *streamCompletion(_model: string, sent: AgentMessage[]): AsyncGenerator<CompletionEvent> {
        seen.push(structuredClone(sent));
        yield { type: 'done', message: { role: 'assistant', content: 'And now this.' }, finishReason: 'stop', usage };
      },
      async actualCostsUsd() { return undefined; }
    };
    const reopened = new AgentConversation(root, () => undefined, stateHomeFor(root).paths.checkpoints, undefined, storeFor(root, new MemorySecrets(), 'edC.1'));
    const turns = await reopened.restore(THREAD);
    assert.deepEqual(turns?.filter((turn) => turn.role === 'user').map((turn) => turn.text).slice(-2), ['Question 4', 'Asked on the other computer']);
    await reopened.send({ text: 'Continue here', client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
    const context = seen[0].map((message) => message.content).join('\n');
    assert.match(context, /Asked on the other computer/, 'the other computer\'s question is in the context the model continues from');
    assert.match(context, /Answered on the other computer/);
    assert.match(context, /Question 1/, 'and so is the earlier history');
    assert.equal(seen[0][0].role, 'system', 'the system prompt stays first');

    const store = storeFor(root, new MemorySecrets(), 'edD.1');
    const lines = await store.lines(THREAD);
    assert.equal((await store.entries(THREAD)).length, before + 2 + 2, 'two entries from the other computer and two new ones; none lost');
    assert.equal(lines.branches.length, 0, 'the new message continues the main line');
    assert.equal(lines.main.at(-2)?.role, 'user');
    assert.equal((lines.main.at(-2)?.body as { text: string }).text, 'Continue here');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Task 3: the panel and the history list share one thread store per project ---------------------------------------------------------------

test('a second editor on the same host lists and reopens the conversation the first editor saved', async () => {
  const root = await tempProject();
  try {
    const editorA = storeFor(root, new MemorySecrets(), 'edA.1');
    const { messages, display } = longConversation(6);
    await editorA.captureTranscript(transcriptOf(messages, THREAD, display), display, new WeakSet());
    await editorA.save(transcriptOf(messages, THREAD, display));

    // Editor B has its own, empty SecretStorage: it shares nothing with A but the project folder, and reads the key file in the state home.
    const editorB = storeFor(root, new MemorySecrets(), 'edB.1');
    const listed = await editorB.list();
    assert.deepEqual(listed.map((item) => [item.id, item.title, item.turns, item.locked]), [[THREAD, 'A long conversation', 6, undefined]]);
    assert.deepEqual(await editorB.lines(THREAD), await editorA.lines(THREAD));
    assert.equal((await editorB.lines(THREAD)).main.length, 24);
    assert.equal((await editorB.load(THREAD))?.messages.length, messages.length, 'and the saved context opens too');
    const reopened = await new AgentConversation(root, () => undefined, stateHomeFor(root).paths.checkpoints, undefined, editorB).restore(THREAD);
    assert.equal(reopened?.filter((turn) => turn.role === 'user').length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the shared store is one per project, and looking at a project writes nothing', async () => {
  const root = await tempProject();
  try {
    const secrets = new MemorySecrets();
    const first = threadStoreFor(root, secrets, 'edA.1');
    assert.equal(threadStoreFor(root, secrets, 'edA.1'), first, 'one store per folder and secret store');
    assert.equal(threadStoreFor(root, new MemorySecrets(), 'edB.1') === first, false, 'another editor has its own');
    assert.deepEqual(await first.list(), []);
    assert.deepEqual(await first.index(), []);
    assert.deepEqual(await first.entries(THREAD), []);
    assert.deepEqual(await readdir(root), [], 'listing an untouched project creates nothing in it');
    await first.captureTranscript(transcriptOf([{ role: 'system', content: 'only the system prompt' }]), new Map(), new WeakSet());
    assert.deepEqual(await readdir(root), [], 'a conversation with nothing to record does not create the state home');
    const { messages, display } = longConversation(1);
    await first.captureTranscript(transcriptOf(messages, THREAD, display), display, new WeakSet());
    assert.ok((await readdir(root)).includes('.near-ai'), 'the first message creates it');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a host with no secret storage still keeps conversations, through the key file in the state home', async () => {
  const root = await tempProject();
  try {
    const store = threadStoreFor(root, undefined, 'edA.1');
    const { messages, display } = longConversation(2);
    await store.captureTranscript(transcriptOf(messages, THREAD, display), display, new WeakSet());
    await store.save(transcriptOf(messages, THREAD, display));
    assert.equal((await store.lines(THREAD)).main.filter((entry) => entry.role === 'user').length, 2);
    assert.equal((await storeFor(root, new MemorySecrets(), 'edB.1').list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
