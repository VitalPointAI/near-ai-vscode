import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { compactConversation, trimOldToolResults } from '../agent/context';
import { DEFAULT_RULES } from '../agent/permissions';
import { contentKey, COMPACTION_ACK } from '../domain/state/threadCapture';
import { AgentConversation, type AgentTurnRequest } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import type { Transcript } from '../services/transcripts';
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
