import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { ThreadEntry } from '../domain/state/threadEntries';
import { DEFAULT_RULES } from '../agent/permissions';
import { entriesToMessages, entriesToView, type ViewItem } from '../domain/state/threadView';
import { AgentConversation } from '../services/agentSession';
import type { AgentMessage, CompletionEvent } from '../services/nearAiClient';
import { isThreadId, openThreadInPanel, PARTICIPANT_STOPPED_NOTICE, recordParticipantTurn, resolveParticipantThread, ResponseRecorder, seedEntries, USAGE_FOOTER_TAIL, type ParticipantTurnLike, type ResponseStreamLike } from '../services/participantRecorder';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 08 (SYNC-01, D-07): the @near chat participant's turns are recorded in the project's state home, whatever VS Code's own 20-turn
// window shows the model. Each test works on a temporary project folder.

class FakeMarkdown { public constructor(public value: string) {} }

/** The reply stream of a chat request: what the person would see, in order. */
class FakeStream implements ResponseStreamLike {
  public readonly seen: string[] = [];
  public markdown(value: string | { value: string }): unknown { this.seen.push(typeof value === 'string' ? value : value.value); return this; }
  public button(): unknown { return this; }
  public progress(): unknown { return this; }
}

function storeFor(root: string, secrets = new MemorySecrets(), writer = 'edA.1'): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer });
}

const textOf = (entry: ThreadEntry): string => (entry.body as { text: string }).text;

/** A reply turn as VS Code's history returns it. */
function reply(text: string, metadata: Record<string, unknown> = {}): ParticipantTurnLike {
  return { participant: 'nearAi', result: { metadata }, response: [{ value: new FakeMarkdown(text) }] };
}

function request(prompt: string, command?: string): ParticipantTurnLike {
  return { participant: 'nearAi', prompt, ...(command ? { command } : {}) };
}

test('a streamed reply keeps the model\'s text apart from its usage footer, and both are kept in a Chat view thread in the order the person saw them', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const stream = new FakeStream();
  const recorder = new ResponseRecorder(stream);
  recorder.progress('Asking m…');
  recorder.answer('Hello');
  recorder.answer(new FakeMarkdown(' world'));
  recorder.markdown('\n\n*m · 12 tokens · $0.0001*');
  assert.deepEqual(stream.seen, ['Hello', ' world', '\n\n*m · 12 tokens · $0.0001*'], 'the real stream receives everything unchanged');
  const finished = recorder.finish('completed');
  assert.equal(finished.text, 'Hello world', 'the model\'s own words');
  assert.equal(finished.notes, '\n\n*m · 12 tokens · $0.0001*', 'the footer is kept apart');
  assert.equal(finished.outcome, 'completed');

  const { threadId } = await resolveParticipantThread([], store);
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'Say hello', reply: finished.text, notes: finished.notes, model: 'm' });

  const main = (await store.lines(threadId)).main;
  assert.deepEqual(main.map((entry) => entry.role), ['user', 'assistant', 'notice']);
  assert.equal(textOf(main[0]), 'Say hello');
  assert.equal(textOf(main[1]), 'Hello world');
  assert.equal(textOf(main[2]).trim(), '*m · 12 tokens · $0.0001*', 'the footer follows the reply as a notice');
  assert.equal((main[2].body as { forContext: boolean }).forContext, false);
  // Reopened, the person sees the reply and then the footer, in order; the model is sent the reply alone.
  assert.deepEqual(entriesToView({ main, branches: [] }).map((item) => `${item.kind}:${(item as { text?: string }).text?.trim()}`), ['user:Say hello', 'assistant:Hello world', 'notice:*m · 12 tokens · $0.0001*']);
  const sent = entriesToMessages(main);
  assert.deepEqual(sent.map((message) => message.role), ['user', 'assistant']);
  assert.equal(JSON.stringify(sent).includes('$'), false, 'no cost reaches the model');
  const meta = await store.meta(threadId);
  assert.equal(meta?.origin, 'chat-view');
  assert.equal(meta?.title, 'Say hello');
  assert.equal(meta?.turns, 1);
  assert.equal((await store.index()).find((item) => item.id === threadId)?.origin, 'chat-view');
});

test('a reply that is only an error is kept as notices and nothing of it reaches the model', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const { threadId } = await resolveParticipantThread([], store);
  const recorder = new ResponseRecorder(new FakeStream());
  recorder.markdown('NEAR AI could not be reached. Check your connection.');
  const finished = recorder.finish('failed');
  assert.equal(finished.text, '');
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'Hi', reply: finished.text, notes: finished.notes, model: 'm', stopped: true });
  const main = (await store.lines(threadId)).main;
  assert.deepEqual(main.map((entry) => entry.role), ['user', 'notice', 'notice'], 'no assistant entry');
  assert.equal(textOf(main[1]), 'NEAR AI could not be reached. Check your connection.');
  assert.equal(textOf(main[2]), PARTICIPANT_STOPPED_NOTICE);
  assert.deepEqual(entriesToMessages(main).map((message) => message.role), ['user']);
  assert.equal(JSON.stringify(entriesToMessages(main)).includes('reached'), false);
});

test('a session from before turns were recorded has a trailing usage footer moved into a notice after its reply', () => {
  const footer = '\n\n*fake/model · Private · 15 tokens · ~$0.0001 est.*';
  const seed = seedEntries([request('Hi'), reply(`Hello there${footer}`), request('Again'), reply('A reply that ends in *emphasis* is not a footer')]);
  assert.deepEqual(seed.map((item) => item.role), ['user', 'assistant', 'notice', 'user', 'assistant']);
  assert.equal((seed[1].body as { text: string }).text, 'Hello there');
  assert.equal((seed[2].body as { text: string }).text, footer);
  assert.equal((seed[2].body as { forContext: boolean }).forContext, false);
  assert.equal((seed[4].body as { text: string }).text, 'A reply that ends in *emphasis* is not a footer');
  assert.equal(USAGE_FOOTER_TAIL.test(footer), true);
  assert.equal(USAGE_FOOTER_TAIL.test('Plain text'), false);
});

test('the Chat view hands the model its earlier replies without their usage footer', () => {
  const footer = '\n\n*fake/model · 15 tokens · $0.0001*';
  const history = chatParticipant.historyFromChatContext([request('Hi'), reply(`Hello there${footer}`)] as never);
  assert.deepEqual(history, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello there' }]);
});

test('the thread id rides in the newest reply, so the next turn continues the same thread, and a first request starts a new one', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const first = await resolveParticipantThread([], store);
  assert.match(first.threadId, /^conv-[a-z0-9-]{6,60}$/);
  await recordParticipantTurn(store, { threadId: first.threadId, writer: 'edA.1', prompt: 'One', reply: 'Answer one', model: 'm' });

  const history = [request('One'), reply('Answer one', { threadId: first.threadId })];
  const second = await resolveParticipantThread(history, store);
  assert.equal(second.threadId, first.threadId);
  await recordParticipantTurn(store, { threadId: second.threadId, writer: 'edA.1', prompt: 'Two', reply: 'Answer two', model: 'm' });

  const main = (await store.lines(first.threadId)).main;
  assert.deepEqual(main.map(textOf), ['One', 'Answer one', 'Two', 'Answer two']);
  assert.equal((await store.index()).filter((item) => item.origin === 'chat-view').length, 1, 'both turns are one thread');
  assert.equal((await store.meta(first.threadId))?.turns, 2);
});

/** A whole exchange as VS Code's history holds it afterwards. */
function exchange(prompt: string, answer: string, threadId?: string): ParticipantTurnLike[] {
  return [request(prompt), reply(answer, threadId ? { threadId } : {})];
}

/** Loads a module that imports vscode, with the part of it these tests read. `config` and `folders` are changed by each test. */
const config: Record<string, unknown> = {};
const folders: Array<{ uri: { fsPath: string } }> = [];
interface CapturedHandler { (request: unknown, context: unknown, stream: unknown, token: unknown): Promise<{ metadata: { command?: string; threadId?: string } }> }
let participantHandler: CapturedHandler | undefined;
function withVscodeStub<T>(load: () => T): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  const vscodeStub = {
    MarkdownString: FakeMarkdown,
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/'), toString() { return this.path; } }) },
    workspace: {
      get workspaceFolders() { return folders.length ? folders : undefined; },
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback), inspect: () => undefined })
    },
    window: {},
    chat: { createChatParticipant: (_id: string, handler: CapturedHandler) => { participantHandler = handler; return {}; } }
  };
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try { return load(); } finally { nodeModule._load = originalLoad; }
}

const chatParticipant = withVscodeStub(() => require('../services/chatParticipant') as typeof import('../services/chatParticipant'));

test('thirty turns are all stored while the model is shown only the last twenty', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const history: ParticipantTurnLike[] = [];
  let threadId = '';
  for (let turn = 1; turn <= 30; turn += 1) {
    const resolved = await resolveParticipantThread(history, store);
    threadId = resolved.threadId;
    await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: `Question ${turn}`, reply: `Answer ${turn}`, model: 'm', ...(resolved.seed ? { seed: resolved.seed } : {}) });
    history.push(...exchange(`Question ${turn}`, `Answer ${turn}`, threadId));
  }
  const entries = await store.entries(threadId);
  assert.equal(entries.length, 60, 'every prompt and every reply is in the log');
  const main = (await store.lines(threadId)).main;
  assert.deepEqual(main.map(textOf).slice(0, 2), ['Question 1', 'Answer 1']);
  assert.deepEqual(main.map(textOf).slice(-2), ['Question 30', 'Answer 30']);
  assert.equal((await store.meta(threadId))?.turns, 30);
  assert.equal(chatParticipant.historyFromChatContext(history as never).length, 20, 'the model window is unchanged: it limits what the model sees, not what is stored');
});

test('a session that began before turns were recorded is seeded once, from the full history, and not again', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const earlier = [...exchange('First', 'Reply 1'), ...exchange('Second', 'Reply 2'), ...exchange('Third', 'Reply 3'), ...exchange('Fourth', 'Reply 4')];
  const history: ParticipantTurnLike[] = [{ participant: 'someoneElse', prompt: 'not ours' }, ...earlier];
  assert.equal(seedEntries(history).length, 8, 'the other participant is left out, the eight turns of this one are kept');

  const resolved = await resolveParticipantThread(history, store);
  assert.equal(resolved.seed?.length, 8);
  await recordParticipantTurn(store, { threadId: resolved.threadId, writer: 'edA.1', prompt: 'Fifth', reply: 'Reply 5', model: 'm', seed: resolved.seed });
  const main = (await store.lines(resolved.threadId)).main;
  assert.deepEqual(main.map(textOf), ['First', 'Reply 1', 'Second', 'Reply 2', 'Third', 'Reply 3', 'Fourth', 'Reply 4', 'Fifth', 'Reply 5']);
  assert.equal((await store.meta(resolved.threadId))?.title, 'First', 'the thread is titled by the first prompt of the session');

  // The reply now carries the thread id: the next turn continues the thread and seeds nothing.
  const next = await resolveParticipantThread([...history, request('Fifth'), reply('Reply 5', { threadId: resolved.threadId })], store);
  assert.equal(next.threadId, resolved.threadId);
  assert.equal(next.seed, undefined);
});

test('seeding turns a command into a notice that does not feed the model', () => {
  const seed = seedEntries([request('3', 'plan-phase'), reply('Started `/gsd-plan-phase 3` in the NEAR AI view.', { command: 'plan-phase' }), ...exchange('Hi', 'Hello')]);
  assert.deepEqual(seed.map((item) => item.role), ['notice', 'user', 'assistant']);
  assert.equal((seed[0].body as { forContext: boolean }).forContext, false);
  assert.match((seed[0].body as { text: string }).text, /\/gsd-plan-phase 3/);
});

test('a reply without metadata joins a thread only on an exact tail match, and otherwise starts a new thread', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const { threadId } = await resolveParticipantThread([], store);
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'One', reply: 'Answer one with a footer *m · 12 tokens · $0.0001*', model: 'm' });
  const before = (await store.entries(threadId)).length;

  // The same exchange, restored without its metadata: it is the thread's tail, so it continues that thread.
  const matched = await resolveParticipantThread(exchange('One', 'Answer one with a footer *m · 12 tokens · $0.0001*'), store);
  assert.equal(matched.threadId, threadId);
  assert.equal(matched.seed, undefined, 'the thread already holds these turns');

  // One character different: not the same exchange, so a new thread, and the existing one is untouched.
  const near = await resolveParticipantThread(exchange('One', 'Answer one with a footer *m · 12 tokens · $0.0002*'), store);
  assert.notEqual(near.threadId, threadId);
  await recordParticipantTurn(store, { threadId: near.threadId, writer: 'edA.1', prompt: 'Two', reply: 'Answer two', model: 'm', ...(near.seed ? { seed: near.seed } : {}) });
  assert.equal((await store.entries(threadId)).length, before, 'no entry was added to or changed in the existing thread');
  assert.equal((await store.index()).filter((item) => item.origin === 'chat-view').length, 2);

  // The same reply under a different prompt is not the tail either.
  const otherPrompt = await resolveParticipantThread(exchange('Something else', 'Answer one with a footer *m · 12 tokens · $0.0001*'), store);
  assert.notEqual(otherPrompt.threadId, threadId);
});

test('a metadata value that is not a thread id is never used', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  for (const bad of ['../../etc/passwd', 'conv-../x', 'conv-', 'x', 42, null, { id: 'conv-abcdef' }]) {
    const resolved = await resolveParticipantThread([request('Hi'), reply('Hello', { threadId: bad })], store);
    assert.match(resolved.threadId, /^conv-[a-z0-9-]{6,60}$/, `a fresh id replaces ${JSON.stringify(bad)}`);
    assert.notEqual(resolved.threadId, bad);
  }
  assert.equal(isThreadId('conv-abc123'), true);
  assert.equal(isThreadId('conv-ABC123'), false);
  assert.equal(isThreadId('conv-abc/../123'), false);
});

test('a cancelled or failed reply is stored with what was streamed and a notice, and the notice does not feed the model', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const { threadId } = await resolveParticipantThread([], store);
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'Tell me a story', reply: 'Once upon a', model: 'm', stopped: true });
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'Try again', reply: '', model: 'm', stopped: true });
  const main = (await store.lines(threadId)).main;
  assert.deepEqual(main.map((entry) => entry.role), ['user', 'assistant', 'notice', 'user', 'notice']);
  assert.equal(textOf(main[1]), 'Once upon a');
  assert.equal(textOf(main[2]), PARTICIPANT_STOPPED_NOTICE);
  assert.equal(PARTICIPANT_STOPPED_NOTICE, 'The reply stopped before it finished.');
  assert.equal((main[2].body as { forContext: boolean }).forContext, false);
  assert.deepEqual(entriesToMessages(main).map((message) => message.role), ['user', 'assistant', 'user'], 'notices are not model messages');
});

test('a /gsd command turn is one notice that does not feed the model', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const { threadId } = await resolveParticipantThread([], store);
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: '3', reply: 'Started `/gsd-plan-phase 3` in the **NEAR AI** view.', model: '', command: 'plan-phase' });
  const main = (await store.lines(threadId)).main;
  assert.equal(main.length, 1);
  assert.equal(main[0].role, 'notice');
  assert.equal((main[0].body as { forContext: boolean }).forContext, false);
  assert.match(textOf(main[0]), /\/gsd-plan-phase 3/);
  assert.deepEqual(entriesToMessages(main), []);
});

/** What the handler is given for one request, and what it streamed. */
async function ask(root: string, text: { prompt: string; command?: string }, history: unknown[] = [], cancelled = false): Promise<{ result: { metadata: { command?: string; threadId?: string } }; markdown: string; buttons: Array<{ command: string; arguments?: unknown[]; title: string }> }> {
  const markdown: string[] = [];
  const buttons: Array<{ command: string; arguments?: unknown[]; title: string }> = [];
  const stream = { markdown: (value: string | { value: string }) => { markdown.push(typeof value === 'string' ? value : value.value); }, button: (button: never) => { buttons.push(button); }, progress: () => undefined };
  folders.splice(0, folders.length, { uri: { fsPath: root } });
  const secrets = sharedSecrets.get(root) ?? new MemorySecrets();
  sharedSecrets.set(root, secrets);
  const context = { extensionUri: { path: '/ext' }, secrets, globalState: { get: () => undefined, update: async () => undefined }, subscriptions: [] as unknown[] };
  const started: string[] = [];
  chatParticipant.registerChatParticipant(context as never, {} as never, async (command) => { started.push(command); });
  assert.ok(participantHandler, 'the participant is registered');
  const token = { isCancellationRequested: cancelled, onCancellationRequested: () => ({ dispose: () => undefined }) };
  const result = await participantHandler!({ ...text, command: text.command }, { history }, stream, token);
  return { result, markdown: markdown.join(''), buttons };
}
const sharedSecrets = new Map<string, MemorySecrets>();

test('the participant records a /gsd command turn, returns its thread id and offers the button that opens it in the panel', async () => {
  const root = await tempProject();
  const { result, markdown, buttons } = await ask(root, { prompt: '', command: 'progress' });
  assert.equal(result.metadata.command, 'progress');
  assert.match(result.metadata.threadId ?? '', /^conv-[a-z0-9-]{6,60}$/);
  assert.match(markdown, /Started `\/gsd-progress`/);
  const open = buttons.find((button) => button.command === 'nearAi.openThread');
  assert.deepEqual(open?.arguments, [result.metadata.threadId]);
  assert.equal(open?.title, 'Open this chat in the NEAR AI panel');
  const store = storeFor(root, sharedSecrets.get(root));
  const main = (await store.lines(result.metadata.threadId!)).main;
  assert.deepEqual(main.map((entry) => entry.role), ['notice']);
  assert.equal((await store.meta(result.metadata.threadId!))?.origin, 'chat-view');
});

test('with nearAi.agent.saveTranscripts off nothing is recorded, no thread id is returned and nothing is created in the project', async () => {
  const root = await tempProject();
  config['agent.saveTranscripts'] = false;
  try {
    const { result, markdown, buttons } = await ask(root, { prompt: '', command: 'progress' });
    assert.match(markdown, /Started `\/gsd-progress`/, 'the reply itself is unchanged');
    assert.equal(result.metadata.threadId, undefined);
    assert.equal(buttons.some((button) => button.command === 'nearAi.openThread'), false);
    await assert.rejects(stat(stateHomeFor(root).paths.dir), /ENOENT/, 'the state home was not created');
  } finally {
    delete config['agent.saveTranscripts'];
  }
});

// The plain-prompt path, with a stand-in provider: what the person reads is what is stored, and how the reply ended decides whether a notice follows.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const providerCache = require('../services/providerCache') as { activeProvider: unknown; clientFor: unknown };
function provideStream(events: (() => AsyncGenerator<unknown>) | undefined): void {
  providerCache.activeProvider = async () => events ? { models: [{ id: 'fake/model', privacyBoundary: 'local' }], provider: { client: {}, provider: 'local' }, profiles: { projectScopeId: 'project-test' }, profile: { profileId: 'p', organization: '' } } : undefined;
  providerCache.clientFor = () => ({ client: { streamChatEvents: events }, local: true });
}
const done = { type: 'done', metadata: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.0001, verificationStatus: 'unknown', latencyMs: 3 } };

test('a plain reply is stored as the model\'s text with its footer as a notice, a cancelled one with a notice, and a failed one with the error text and a notice', async () => {
  const root = await tempProject();
  provideStream(async function* () { yield { type: 'text', text: 'Hello' }; yield { type: 'text', text: ' there' }; yield done; });
  const completed = await ask(root, { prompt: 'Greet me' });
  const store = storeFor(root, sharedSecrets.get(root));
  const threadId = completed.result.metadata.threadId!;
  let main = (await store.lines(threadId)).main;
  assert.deepEqual(main.map((entry) => entry.role), ['user', 'assistant', 'notice']);
  assert.equal(textOf(main[1]), 'Hello there', 'the model\'s own words');
  assert.equal(`${textOf(main[1])}${textOf(main[2])}`, completed.markdown, 'together they are what the person read');
  assert.match(textOf(main[2]), /^\n\n\*fake\/model · .*15 tokens/);
  assert.equal(entriesToMessages(main).some((message) => String(message.content).includes('tokens')), false, 'the footer never reaches the model');
  assert.equal(completed.buttons.filter((button) => button.command === 'nearAi.openThread').length, 1);
  assert.equal((await store.meta(threadId))?.model, 'fake/model');

  // The next request carries the id and the cancelled reply keeps what was streamed.
  const history = [...exchange('Greet me', completed.markdown, threadId)];
  provideStream(async function* () { yield { type: 'text', text: 'Once upon' }; yield { type: 'status', status: 'cancelled' }; });
  const cancelled = await ask(root, { prompt: 'Tell a story' }, history, true);
  assert.equal(cancelled.result.metadata.threadId, threadId);
  main = (await store.lines(threadId)).main;
  assert.deepEqual(main.slice(3).map((entry) => entry.role), ['user', 'assistant', 'notice']);
  assert.equal(textOf(main[4]), 'Once upon');
  assert.equal(textOf(main[5]), PARTICIPANT_STOPPED_NOTICE);

  provideStream(async function* () { yield { type: 'text', text: 'Partial' }; throw new Error('connection reset'); });
  const failed = await ask(root, { prompt: 'Again' }, history);
  main = (await store.lines(threadId)).main;
  assert.equal(main.at(-1)?.role, 'notice');
  assert.equal(textOf(main.at(-1)!), PARTICIPANT_STOPPED_NOTICE);
  assert.equal(textOf(main.at(-3)!), 'Partial', 'the partial text is the reply');
  assert.equal(textOf(main.at(-2)!), failed.markdown.slice('Partial'.length), 'the error shown to the person is a notice after it');
  assert.equal(entriesToMessages(main).some((message) => String(message.content).includes('connection reset')), false, 'error text never reaches the model');
});

test('a Chat view reply restored without its metadata still finds its thread, though the thread holds the footer as a notice', async () => {
  const root = await tempProject();
  provideStream(async function* () { yield { type: 'text', text: 'Hello there' }; yield done; });
  const completed = await ask(root, { prompt: 'Greet me' });
  const store = storeFor(root, sharedSecrets.get(root));
  const threadId = completed.result.metadata.threadId!;
  const before = (await store.entries(threadId)).length;
  const joined = await resolveParticipantThread(exchange('Greet me', completed.markdown), store);
  assert.equal(joined.threadId, threadId, 'the reply as the person saw it, footer included, is this thread\'s tail');
  assert.equal(joined.seed, undefined);
  assert.equal((await store.entries(threadId)).length, before);
});

test('a prompt that never reached the model is not stored, and the session still gets its thread id', async () => {
  const root = await tempProject();
  provideStream(undefined);
  const { result, markdown } = await ask(root, { prompt: 'secret prompt text' });
  assert.match(markdown, /no validated NEAR AI profile/);
  const threadId = result.metadata.threadId!;
  assert.match(threadId, /^conv-/);
  const store = storeFor(root, sharedSecrets.get(root));
  assert.deepEqual((await store.entries(threadId)), [], 'no exchange was kept');

  // A session from before this version still gets its one-time seed, even when this request itself was not sent.
  const older = await tempProject();
  const sessionBefore = [...exchange('Old question', 'Old answer')];
  const second = await ask(older, { prompt: 'New question' }, sessionBefore);
  const seeded = (await storeFor(older, sharedSecrets.get(older)).lines(second.result.metadata.threadId!)).main;
  assert.deepEqual(seeded.map(textOf), ['Old question', 'Old answer']);
});

test('a Chat view thread reopens in the NEAR AI panel of another editor with its whole history, and the next message continues it', async () => {
  const root = await tempProject();
  try {
    const store = storeFor(root);
    const { threadId } = await resolveParticipantThread([], store);
    await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'First question', reply: 'First answer', model: 'm' });
    await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'Second question', reply: 'Half an ans', model: 'm', stopped: true });
    await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: '', reply: 'Started `/gsd-progress` in the **NEAR AI** view.', model: 'm', command: 'progress' });

    // Another editor on the same host, with nothing of its own but the project folder.
    const seen: AgentMessage[][] = [];
    const client = {
      async *streamCompletion(_model: string, sent: AgentMessage[]): AsyncGenerator<CompletionEvent> {
        seen.push(structuredClone(sent));
        yield { type: 'done', message: { role: 'assistant', content: 'Carrying on.' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } } as CompletionEvent;
      },
      async actualCostsUsd() { return undefined; }
    };
    const reopened = new AgentConversation(root, () => undefined, stateHomeFor(root).paths.checkpoints, undefined, storeFor(root, new MemorySecrets(), 'edB.1'));
    const restored = await reopened.restore(threadId);
    assert.ok(restored && !Array.isArray(restored), 'the thread opens');
    const items = (restored as { items: ViewItem[] }).items;
    assert.deepEqual(items.map((item) => item.kind), ['user', 'assistant', 'user', 'assistant', 'notice', 'notice'], 'every prompt, every reply and the notices, in order');
    assert.equal((items[1] as { text: string }).text, 'First answer');

    await reopened.send({ text: 'Third question', client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
    assert.equal(seen[0][0].role, 'system', 'a thread that began in the Chat view still gets the panel\'s system prompt, first');
    assert.deepEqual(seen[0].slice(1).map((message) => `${message.role}:${message.content}`), ['user:First question', 'assistant:First answer', 'user:Second question', 'assistant:Half an ans', 'user:Third question'], 'the notices are not sent to the model');
    const main = (await storeFor(root).lines(threadId)).main;
    assert.deepEqual(main.slice(-2).map(textOf), ['Third question', 'Carrying on.'], 'the panel continues the same thread');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nearAi.openThread shows the panel and reopens the thread, and refuses an id that is not a thread id', async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  const panel = { focus: async () => { calls.push('focus'); }, resume: async (id: string) => { calls.push(`resume ${id}`); } };
  assert.equal(await openThreadInPanel('conv-abc123-def', panel, (text) => warnings.push(text)), true);
  assert.deepEqual(calls, ['focus', 'resume conv-abc123-def']);
  for (const bad of ['../../etc/passwd', 'conv-', '', 7, undefined, { id: 'conv-abc123' }]) assert.equal(await openThreadInPanel(bad, panel, (text) => warnings.push(text)), false);
  assert.equal(calls.length, 2, 'a bad id reaches neither the view nor the panel');
  assert.equal(warnings.length, 6);
  const extension = (await readFile(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8'));
  assert.match(extension, /registerCommand\('nearAi\.openThread'/, 'the command is registered');
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> } };
  assert.equal(manifest.contributes.commands.some((entry) => entry.command === 'nearAi.openThread'), false, 'it is not in the Command Palette');
});
