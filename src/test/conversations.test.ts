import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { ProfileStore } from '../services/profileStore';
import { deriveProfileId } from '../domain/auth';
import { ActivityStore, closeInterruptedRuns } from '../services/activityStore';
import { historyPage } from '../services/activityOverview';
import { threadStoreFor } from '../services/threadStore';
import { RunMarkers } from '../services/runMarkers';
import { editorWriter, stateHomeFor, writerEditor } from '../services/stateHome';
import { ConversationLog, conversationStatus, conversationTitle, MAX_OPEN_CONVERSATIONS, parseSavedConversations, savedConversations } from '../services/conversations';

// Several conversations in the sidebar at once, as in Claude Code: each has its own run,
// prompts, steering queue, transcript, and spend and activity ID; the view shows one, and a
// background conversation keeps running into its own log until the user switches to it.

// --- Pure parts ---

/** The texts a transcript message shows: its items (a thread with a log, plan 06) or its turns (a thread saved without one). */
function shownTexts(message: Record<string, unknown>): string[] {
  return ((message.items ?? message.turns) as Array<{ text?: string }>).flatMap((entry) => (typeof entry.text === 'string' ? [entry.text] : []));
}

test('a conversation title is the first line, redacted as run titles are, about 40 characters', () => {
  assert.equal(conversationTitle('  \nFix the login bug\nand more'), 'Fix the login bug');
  const long = conversationTitle('Refactor the payment reconciliation module so that every ledger entry is checked');
  assert.ok(long && long.length <= 40 && long.endsWith('…'), long);
  assert.doesNotMatch(conversationTitle('use api_key=sk-live-1234567890abcdef please') ?? '', /sk-live-1234567890abcdef/);
  assert.equal(conversationTitle('   '), undefined);
});

test('status: waiting for you beats running, which beats how the last turn ended', () => {
  assert.equal(conversationStatus({ running: true, waiting: 1, outcome: 'done' }), 'waiting');
  assert.equal(conversationStatus({ running: true, waiting: 0, outcome: 'error' }), 'running');
  assert.equal(conversationStatus({ running: false, waiting: 0, outcome: 'stopped' }), 'stopped');
  assert.equal(conversationStatus({ running: false, waiting: 0, outcome: 'idle' }), 'idle');
});

test('the saved conversation list is read strictly and capped', () => {
  const id = (n: number) => `conv-abcdef${n}`;
  const parsed = parseSavedConversations({ activeId: id(2), items: [{ id: id(1), title: 'One', status: 'done' }, { id: id(1), title: 'dupe' }, { id: '../etc', title: 'x' }, 'junk', { id: id(2), title: 42, status: 'exploded' }] });
  assert.deepEqual(parsed, { activeId: id(2), items: [{ id: id(1), title: 'One', status: 'done' }, { id: id(2), title: '', status: 'idle' }] });
  assert.deepEqual(parseSavedConversations({ activeId: id(9), items: [] }), { items: [] }, 'an active id that is not listed is dropped');
  assert.deepEqual(parseSavedConversations(undefined), { items: [] });
  assert.equal(parseSavedConversations({ items: Array.from({ length: 20 }, (_, n) => ({ id: id(n + 10), title: 't' })) }).items.length, MAX_OPEN_CONVERSATIONS);
  assert.deepEqual(savedConversations([{ id: id(1), title: 'A', status: 'waiting', unread: true, waiting: 1 }, { id: id(2), title: 'B', status: 'done', unread: false, waiting: 0 }], id(1)).items.map((item) => item.status), ['running', 'done'], 'a waiting conversation is one a reload cuts off');
});

test('the log merges streamed text, keeps only the latest panels, and replays prompts as waiting or settled', () => {
  const log = new ConversationLog();
  log.add({ type: 'assistant-start', model: 'm' });
  log.add({ type: 'assistant-delta', text: 'Hel' });
  log.add({ type: 'assistant-delta', text: 'lo' });
  log.add({ type: 'todos', todos: [{ content: 'a' }] });
  log.add({ type: 'approval-request', callId: 'c1', title: 'Edit a.ts' });
  log.add({ type: 'questions-request', id: 'q-0123456789ab', questions: [{ question: 'Which?' }, { question: 'And?' }] });
  log.add({ type: 'todos', todos: [{ content: 'b' }] });
  log.add({ type: 'progress', text: 'Still working (1 min)' });
  log.add({ type: 'progress', text: 'Still working (3 min)' });
  log.add({ type: 'approval-expired', callId: 'c1', minutes: 15 });
  const posted = { type: 'assistant-delta', text: 'x' };
  log.add(posted);
  log.add({ type: 'assistant-delta', text: 'y' });
  assert.equal(posted.text, 'x', 'a posted message is never changed');
  const replay = log.replay(new Map([['q-0123456789ab', { type: 'questions-request', id: 'q-0123456789ab', questions: [] }]]), new Map([['c1', { outcome: 'expired', detail: 15 }]]));
  assert.deepEqual(replay.map((message) => message.type), ['assistant-start', 'assistant-delta', 'prompt-record', 'questions-request', 'todos', 'progress', 'assistant-delta']);
  assert.ok(replay.every((message) => message.replay === true));
  assert.equal(replay[1].text, 'Hello');
  assert.deepEqual(replay[2], { type: 'prompt-record', kind: 'approval', title: 'Edit a.ts', outcome: 'expired', detail: 15, replay: true });
  assert.deepEqual(replay[4].todos, [{ content: 'b' }]);
  assert.equal(replay[5].text, 'Still working (3 min)');
  assert.equal(replay[6].text, 'xy');
  // A waiting prompt the log no longer holds is pinned at the end.
  const empty = new ConversationLog();
  assert.deepEqual(empty.replay(new Map([['c9', { type: 'approval-request', callId: 'c9' }]]), new Map()), [{ type: 'approval-request', callId: 'c9', replay: true }]);
  // A long log drops its oldest entries and says so.
  const small = new ConversationLog(8);
  for (let index = 0; index < 12; index += 1) small.add({ type: 'notice', text: String(index) });
  const trimmed = small.replay(new Map(), new Map());
  assert.match(String(trimmed[0].text), /no longer shown here/);
  assert.ok(trimmed.length <= 9);
});

test('a run left running by an earlier extension host is recorded as stopped, and history shows it stopped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-interrupted-'));
  let clock = Date.parse('2026-10-28T10:00:00.000Z');
  const store = new ActivityStore(root, { clock: () => new Date(clock).toISOString() });
  const cut = await store.start({ project: 'demo', runId: 'run-1-aaaaaa', conversationId: 'conv-cut-0001', title: 'Long job', summary: 'Agent conversation turn started.' });
  clock += 60_000;
  await store.append(cut.sessionId, { status: 'running', kind: 'tool', summary: 'Tool call started.' });
  const finished = await store.start({ project: 'demo', runId: 'run-2-bbbbbb', summary: 'Agent conversation turn started.' });
  await store.append(finished.sessionId, { status: 'completed', kind: 'message', summary: 'Agent run completed.' });
  clock += 3_600_000;
  assert.equal(historyPage(await store.list(), 0, undefined, clock).rows.find((row) => row.runId === 'run-1-aaaaaa')?.outcome, 'running', 'before: shown as running forever');

  assert.equal(await closeInterruptedRuns(root), 1);
  assert.equal(await closeInterruptedRuns(root), 1, 'once per extension host: the same result, nothing closed again');
  const after = new ActivityStore(root);
  const session = await after.get(cut.sessionId);
  assert.equal(session?.outcome, 'cancelled');
  assert.equal(session?.runOutcome, 'cancelled');
  assert.equal(session?.endedAt, '2026-10-28T10:01:00.000Z', 'it ended at its last activity, not at the reload');
  assert.match(String(session?.events.at(-1)?.summary), /VS Code reloaded/);
  const row = historyPage(await after.list(), 0).rows.find((candidate) => candidate.runId === 'run-1-aaaaaa');
  assert.equal(row?.outcome, 'cancelled');
  assert.equal(row?.durationMs, 60_000);
  assert.equal((await after.get(finished.sessionId))?.outcome, 'completed', 'finished runs are untouched');

  // A project with no history gets no history file.
  const empty = await mkdtemp(path.join(tmpdir(), 'near-ai-interrupted-none-'));
  assert.equal(await closeInterruptedRuns(empty), 0);
  assert.equal(existsSync(path.join(empty, '.planning')), false);
});

test('the bridge parses the conversation messages strictly', () => {
  const id = 'conv-mf3k2-0a1b2c3d';
  assert.deepEqual(parseChatWebviewMessage({ type: 'switch-conversation', id }), { type: 'switch-conversation', id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'close-conversation', id }), { type: 'close-conversation', id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'new-chat' }), { type: 'new-chat' });
  for (const bad of [{ type: 'switch-conversation' }, { type: 'switch-conversation', id: '../x' }, { type: 'close-conversation', id, extra: 1 }, { type: 'switch-conversation', id: 'conv-' }]) assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad));
  // Conversation-bound messages may name their conversation; a malformed name rejects the message.
  assert.deepEqual(parseChatWebviewMessage({ type: 'send', text: 'hi', conversationId: id }), { type: 'send', text: 'hi', model: undefined, conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id: 'steer-0123456789ab', text: 'hi', conversationId: id }), { type: 'steer', id: 'steer-0123456789ab', text: 'hi', conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'stop', conversationId: id }), { type: 'stop', conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'stop' }), { type: 'stop' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'approval-reply', callId: 'call_1', decision: 'allow', conversationId: id }), { type: 'approval-reply', callId: 'call_1', decision: 'allow', conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'questions-reply', id: 'q-0123456789ab', answers: ['a'], conversationId: id }), { type: 'questions-reply', id: 'q-0123456789ab', answers: ['a'], conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-command', command: 'gsd-progress', conversationId: id }), { type: 'open-command', command: 'gsd-progress', conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'revert-run', runId: 'run-1-abcdef', conversationId: id }), { type: 'revert-run', runId: 'run-1-abcdef', conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'verify-response', runId: 'run-1-abcdef' }), { type: 'verify-response', runId: 'run-1-abcdef' });
  for (const bad of [
    { type: 'send', text: 'hi', conversationId: 'conv-../../x' },
    { type: 'send', text: 'hi', conversationId: 42 },
    { type: 'stop', conversationId: 'session-1234567890' },
    { type: 'stop', conversationId: id, extra: true },
    { type: 'chat-ready', conversationId: id },
    { type: 'load-models', conversationId: id },
    { type: 'revert-run', runId: 'run-1-abcdef', conversationId: id, extra: 1 }
  ]) assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad));
});

test('the view has a conversation tab list with keyboard switching, and no dead history paths', () => {
  const view = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  assert.ok(view.indexOf('id="conversations"') < view.indexOf('id="transcript"'), 'the strip is above the conversation');
  assert.match(view, /<div id="conversation-tabs" role="tablist"/);
  assert.match(view, /<button id="new-conversation" class="icon-button" type="button" aria-label="New conversation"/);
  assert.match(view, /<div id="needs-you" role="status" hidden><\/div>/);
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /tab\.setAttribute\('role', 'tab'\)/);
  assert.match(script, /tab\.setAttribute\('aria-selected', String\(selected\)\)/);
  assert.match(script, /event\.code === 'BracketLeft'/);
  assert.match(script, /event\.code === 'BracketRight'/);
  assert.match(script, /conversations need you/);
  assert.match(script, /function postFor\(message\)/);
  for (const dead of ['continue-session', 'reopen-session', 'session-reopened']) assert.doesNotMatch(script, new RegExp(dead), dead);
  const chat = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'chat.ts'), 'utf8');
  for (const dead of ['reopen-session', 'continue-session', "type === 'history'"]) assert.equal(chat.includes(dead), false, dead);
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(css, /#conversation-tabs \{[^}]*min-width: 0;[^}]*overflow-x: auto;/, 'the tabs scroll inside the strip, not the page');
});

// --- The sidebar host path: the real chat.ts handler, AgentConversation, and NearAiClient against a fake NEAR. ---

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

class Memento {
  private readonly values = new Map<string, unknown>();
  public get<T>(key: string, fallback?: T): T | undefined { return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); return Promise.resolve(); }
}

const warnings: string[] = [];
const windowListeners: Array<(state: { focused: boolean }) => void> = [];
let confirmClose: string | undefined;
/**
 * PERF-05: whether nearAi.agent.autoResumeAfterReload is on in these tests. Off by default here, so the tests of the Resume and Dismiss buttons keep
 * testing what a person does with the setting off; the auto-resume test turns it on.
 */
const autoResume = { on: false };
const vscodeStub = {
  workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }>, name: 'demo', getConfiguration: () => ({ get: (key: string, fallback?: unknown) => (key === 'agent.autoResumeAfterReload' ? autoResume.on : fallback), inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showInformationMessage: () => undefined, showWarningMessage: async (text: string) => { warnings.push(text); return /Stop it and close/.test(text) ? confirmClose : undefined; }, activeTextEditor: undefined, state: { focused: true }, onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => { windowListeners.push(listener); return { dispose() {} }; } },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

type Posted = Record<string, unknown>;

async function openSidebar(root: string, auth: AuthService, shared: { secrets: SecretStorageLike; workspaceState: Memento }) {
  const posted: Posted[] = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const view = {
    badge: undefined as { value: number; tooltip: string } | undefined,
    webview: { html: '', postMessage: async (message: Posted) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} })
  };
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try {
    const { attachChatToView } = require('../services/chat') as typeof import('../services/chat');
    await attachChatToView({ subscriptions: [], globalStorageUri: { fsPath: path.join(root, '.global') }, extensionUri: { fsPath: root }, secrets: shared.secrets, workspaceState: shared.workspaceState } as never, auth, view as never, '<html></html>');
  } finally {
    nodeModule._load = originalLoad;
  }
  const send = (message: unknown) => receive!(message);
  const summary = () => posted.filter((message) => message.type === 'conversations').at(-1) as { activeId: string; items: Array<{ id: string; title: string; status: string; unread: boolean; waiting: number }>; waiting: number } | undefined;
  const item = (id: string) => summary()?.items.find((entry) => entry.id === id);
  await send({ type: 'chat-ready' });
  return { posted, view, send, summary, item };
}

// One secret store for the file: the transcript key is shared process-wide, as in the extension.
const secrets = new MemorySecrets();

async function projectWithProfile() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-convs-'));
  const auth = new AuthService(secrets);
  const profiles = new ProfileStore(root, auth, { validator: async () => undefined });
  await profiles.configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  await writeFile(path.join(root, 'app.ts'), 'export const port = 3000;\n');
  return { root, auth, shared: { secrets, workspaceState: new Memento() } };
}

type Delta = { content?: string; tool_calls?: Array<{ index: number; id: string; function: { name: string; arguments: string } }> };
type Wire = Array<{ role: string; content: unknown }>;

/** A fake NEAR whose chat turns come from `next`, which sees each request's messages. */
function fakeNear(next: (messages: Wire) => Promise<Delta> | Delta) {
  const requests: Wire[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/models/pricing')) return new Response('{}', { status: 404 });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1, output: 1 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }] });
    if (url.endsWith('/billing/costs')) return Response.json({ requests: [] });
    if (url.endsWith('/chat/completions')) {
      const messages = JSON.parse(String(init?.body)).messages as Wire;
      requests.push(messages);
      // Like a real request, a held reply ends when the run is stopped.
      const delta = await Promise.race([next(messages), new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new DOMException('The operation was aborted.', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
      })]);
      const body = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}', 'data: [DONE]', ''].join('\n\n');
      return new Response(body, { status: 200, headers: { 'inference-id': '0b6e3f9e-5a1d-5c2b-8f4e-1d2c3b4a5f60' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

async function until<T>(read: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

const firstUser = (messages: Wire) => String(messages.filter((message) => message.role === 'user')[0]?.content ?? '');
const lastUser = (messages: Wire) => String(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '');
const editCall: Delta = { tool_calls: [{ index: 0, id: 'call_edit', function: { name: 'Edit', arguments: '{"file_path":"app.ts","old_string":"3000","new_string":"8080"}' } }] };
/** Replies held until released, by the text of the conversation's first message. */
function gates() {
  const held = new Map<string, () => void>();
  return {
    hold: (text: string) => new Promise<void>((resolve) => { held.set(text, resolve); }),
    release: (text: string) => { held.get(text)?.(); held.delete(text); },
    holding: (text: string) => held.has(text)
  };
}
const since = (posted: Posted[], index: number) => posted.slice(index);
const MODEL = 'z-ai/glm-5.3';

async function withNear<T>(near: ReturnType<typeof fakeNear>, work: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try { return await work(); } finally { globalThis.fetch = originalFetch; }
}

test('sidebar: two conversations run at once with their own transcripts; a background one keeps its output until shown', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const near = fakeNear(async (messages) => {
    if (firstUser(messages) === 'slow task' && !messages.some((message) => message.role === 'assistant')) await gate.hold('slow task');
    return { content: `Saw: ${lastUser(messages)}` };
  });
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    assert.equal(sidebar.summary()!.items.length, 1);
    const slow = sidebar.send({ type: 'send', text: 'slow task', model: MODEL, conversationId: a });
    await until(() => gate.holding('slow task'));
    assert.equal(sidebar.item(a)?.status, 'running');
    assert.equal(sidebar.item(a)?.title, 'slow task');

    // A new conversation while the first one runs: the composer is not held up.
    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;
    assert.notEqual(b, a);
    const switched = sidebar.posted.length;
    await sidebar.send({ type: 'send', text: 'quick question', model: MODEL, conversationId: b });
    assert.equal(sidebar.item(b)?.status, 'done');
    assert.equal(sidebar.item(a)?.status, 'running', 'the first is still running');

    gate.release('slow task');
    await slow;
    await until(() => sidebar.item(a)?.status === 'done');
    assert.equal(sidebar.item(a)?.unread, true, 'output arrived while it was in the background');
    const shownWhileB = since(sidebar.posted, switched);
    assert.equal(shownWhileB.some((message) => message.type === 'assistant-delta' && String(message.text).includes('slow task')), false, 'a background conversation\'s output is not shown in the one on screen');
    assert.equal(shownWhileB.filter((message) => message.type === 'assistant-done').length, 1, 'only the one on screen finished on screen');

    // Each conversation's model requests carry only its own messages.
    const slowRequest = near.requests.find((messages) => firstUser(messages) === 'slow task')!;
    const quickRequest = near.requests.find((messages) => firstUser(messages) === 'quick question')!;
    assert.equal(JSON.stringify(slowRequest).includes('quick question'), false);
    assert.equal(JSON.stringify(quickRequest).includes('slow task'), false);

    // Switching back shows it again: what was sent, the reply, and it is no longer unread.
    const before = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: a });
    const shown = since(sidebar.posted, before);
    assert.deepEqual(shown[0], { type: 'conversation-show', id: a, title: 'slow task', model: MODEL });
    assert.ok(shown.some((message) => message.type === 'user-turn' && message.text === 'slow task' && message.replay));
    assert.ok(shown.some((message) => message.type === 'assistant-delta' && message.text === 'Saw: slow task' && message.replay));
    assert.ok(shown.some((message) => message.type === 'assistant-done' && message.replay));
    assert.equal(shown.some((message) => message.type === 'user-turn' && message.text === 'quick question'), false);
    assert.deepEqual(shown.find((message) => message.type === 'conversation-shown'), { type: 'conversation-shown', id: a, busy: false });
    assert.equal(sidebar.item(a)?.unread, false);

    // Each conversation is its own activity (and spend) window.
    const sessions = await new ActivityStore(root).list();
    assert.deepEqual(new Set(sessions.map((session) => session.conversationId)), new Set([a, b]));
    const { sharedActivityFeed } = require('../services/activityView') as typeof import('../services/activityView');
    assert.equal(sharedActivityFeed().currentConversation, a, 'Agent Activity\'s "this conversation" follows the one on screen');
  });
});

test('sidebar: a background conversation\'s approval keeps it waiting, counts in the badge, and is answered only in its own conversation', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const near = fakeNear((messages) => messages.some((message) => message.role === 'tool') ? { content: `done: ${firstUser(messages)}` } : editCall);
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    const runA = sidebar.send({ type: 'send', text: 'edit in A', model: MODEL, conversationId: a });
    await until(() => sidebar.item(a)?.status === 'waiting');
    assert.deepEqual(sidebar.view.badge, { value: 1, tooltip: 'NEAR AI is waiting for you' });

    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;
    const runB = sidebar.send({ type: 'send', text: 'edit in B', model: MODEL, conversationId: b });
    await until(() => sidebar.item(b)?.status === 'waiting');
    assert.equal(sidebar.summary()!.waiting, 2);
    assert.deepEqual(sidebar.view.badge, { value: 2, tooltip: 'NEAR AI is waiting for you in 2 conversations' });
    assert.equal(sidebar.item(a)?.status, 'waiting', 'still waiting in the background');

    // Both runs asked under the same call id; the reply goes to the conversation it names.
    await sidebar.send({ type: 'approval-reply', callId: 'call_edit', decision: 'deny', conversationId: b });
    await runB;
    assert.equal(sidebar.item(b)?.status, 'done');
    assert.equal(sidebar.item(a)?.status, 'waiting', 'A\'s prompt was not answered by B\'s reply');
    assert.deepEqual(sidebar.view.badge, { value: 1, tooltip: 'NEAR AI is waiting for you' });

    // Switching pins A's prompt again; answering it there lets A finish.
    const before = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: a });
    const replayed = since(sidebar.posted, before).filter((message) => message.type === 'approval-request');
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].replay, true);
    await sidebar.send({ type: 'approval-reply', callId: 'call_edit', decision: 'allow', conversationId: a });
    await runA;
    assert.equal(sidebar.item(a)?.status, 'done');
    assert.equal(sidebar.view.badge, undefined);
    // Each run got its own decision: B's tool call was declined, A's was allowed and ran.
    const toolResult = (first: string) => String(near.requests.filter((messages) => firstUser(messages) === first).at(-1)!.find((message) => message.role === 'tool')?.content ?? '');
    assert.match(toolResult('edit in B'), /declin|denied/i);
    assert.doesNotMatch(toolResult('edit in A'), /declin|denied/i);

    // B shown again: its settled prompt is a record of the outcome, not a pinned prompt.
    const again = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: b });
    const shownB = since(sidebar.posted, again);
    assert.equal(shownB.some((message) => message.type === 'approval-request'), false);
    const record = shownB.find((message) => message.type === 'prompt-record');
    assert.equal(record?.kind, 'approval');
    assert.equal(record?.outcome, 'deny');
    assert.match(String(record?.title), /app\.ts/);
  });
});

test('sidebar: steering goes only to the conversation on screen', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const near = fakeNear(async (messages) => {
    if (firstUser(messages) === 'long job' && !messages.some((message) => message.role === 'assistant')) await gate.hold('long job');
    return { content: `Saw: ${lastUser(messages)}` };
  });
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    const runA = sidebar.send({ type: 'send', text: 'long job', model: MODEL, conversationId: a });
    await until(() => gate.holding('long job'));
    // Steering A while it is on screen queues it for A's run.
    await sidebar.send({ type: 'steer', id: 'steer-aaaaaaaaaaaa', text: 'use port 8080', conversationId: a });
    assert.deepEqual(sidebar.posted.filter((message) => message.type === 'steer-state' && message.id === 'steer-aaaaaaaaaaaa').map((message) => message.state), ['queued']);

    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;
    // B is idle: a message typed there is B's own new turn, not direction for A's run.
    await sidebar.send({ type: 'steer', id: 'steer-bbbbbbbbbbbb', text: 'what is 2+2', conversationId: b });
    assert.equal(lastUser(near.requests.at(-1)!), 'what is 2+2');
    assert.equal(firstUser(near.requests.at(-1)!), 'what is 2+2', 'it started B\'s conversation');

    gate.release('long job');
    await runA;
    const aRequests = near.requests.filter((messages) => firstUser(messages) === 'long job');
    assert.equal(aRequests.length, 2);
    assert.match(lastUser(aRequests[1]), /<user-message-during-run>\nuse port 8080/);
    assert.equal(aRequests.some((messages) => JSON.stringify(messages).includes('what is 2+2')), false);
    // The queued message is shown again with A, where it was delivered.
    const before = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: a });
    assert.ok(since(sidebar.posted, before).some((message) => message.type === 'steer-state' && message.state === 'queued' && message.text === 'use port 8080' && message.replay));
  });
});

test('sidebar: Stop stops only the conversation on screen; the emergency stop stops them all', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const near = fakeNear(async (messages) => {
    const first = firstUser(messages);
    if (!messages.some((message) => message.role === 'assistant')) await gate.hold(first);
    return { content: `Saw: ${first}` };
  });
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    void sidebar.send({ type: 'send', text: 'job one', model: MODEL, conversationId: a });
    await until(() => gate.holding('job one'));
    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;
    void sidebar.send({ type: 'send', text: 'job two', model: MODEL, conversationId: b });
    await until(() => gate.holding('job two'));
    await sidebar.send({ type: 'new-chat' });
    const c = sidebar.summary()!.activeId;
    void sidebar.send({ type: 'send', text: 'job three', model: MODEL, conversationId: c });
    await until(() => gate.holding('job three'));

    await sidebar.send({ type: 'stop' });
    await until(() => sidebar.item(c)?.status === 'stopped');
    assert.equal(sidebar.item(a)?.status, 'running');
    assert.equal(sidebar.item(b)?.status, 'running');

    const { setEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
    await setEmergencyStop(true);
    await until(() => sidebar.item(a)?.status === 'stopped' && sidebar.item(b)?.status === 'stopped');
    await setEmergencyStop(false);
    for (const text of ['job one', 'job two', 'job three']) gate.release(text);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(near.requests.length, 3, 'nothing more was sent');
  });
});

test('sidebar: closing a running conversation asks, stops it, and keeps its transcript in history', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const near = fakeNear(async (messages) => {
    if (firstUser(messages) === 'keep going' && !messages.some((message) => message.role === 'assistant')) await gate.hold('keep going');
    return { content: 'ok' };
  });
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    const runA = sidebar.send({ type: 'send', text: 'keep going', model: MODEL, conversationId: a });
    await until(() => gate.holding('keep going'));
    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;

    // Declining the confirmation keeps it open and running.
    confirmClose = undefined;
    await sidebar.send({ type: 'close-conversation', id: a });
    assert.match(warnings.at(-1)!, /"keep going" is still running\. Stop it and close/);
    assert.equal(sidebar.item(a)?.status, 'running');

    confirmClose = 'Stop and close';
    await sidebar.send({ type: 'close-conversation', id: a });
    assert.equal(sidebar.item(a), undefined, 'the tab is gone');
    assert.equal(sidebar.summary()!.activeId, b);
    gate.release('keep going');
    await runA;
    assert.equal(near.requests.length, 1, 'it was stopped');
    const saved = await threadStoreFor(root, shared.secrets as never, 'testseed.1').list();
    assert.ok(saved.some((transcript) => transcript.id === a && transcript.title === 'keep going'), 'its transcript stays in history');

    // A stale message for the closed conversation goes nowhere.
    const count = near.requests.length;
    await sidebar.send({ type: 'send', text: 'hello?', model: MODEL, conversationId: a });
    assert.equal(near.requests.length, count);

    // History opens it again as a tab (here, into the empty conversation on screen).
    await sidebar.send({ type: 'resume-conversation', id: a });
    assert.equal(sidebar.summary()!.activeId, a);
    assert.equal(sidebar.summary()!.items.length, 1, 'the empty conversation was reused');
    assert.ok(sidebar.posted.some((message) => message.type === 'transcript' && message.replay && shownTexts(message)[0] === 'keep going'));
    // Opening one that is already open just shows it.
    await sidebar.send({ type: 'new-chat' });
    await sidebar.send({ type: 'resume-conversation', id: a });
    assert.equal(sidebar.summary()!.activeId, a);
    assert.equal(sidebar.summary()!.items.length, 2);
  });
});

test('sidebar: at most eight conversations are open; a blank one is reused rather than opening another', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const near = fakeNear((messages) => ({ content: `Saw: ${lastUser(messages)}` }));
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    await sidebar.send({ type: 'new-chat' });
    await sidebar.send({ type: 'new-chat' });
    assert.equal(sidebar.summary()!.items.length, 1, 'New conversation on an empty one keeps it');
    for (let index = 0; index < MAX_OPEN_CONVERSATIONS; index += 1) {
      if (index) await sidebar.send({ type: 'new-chat' });
      await sidebar.send({ type: 'send', text: `question ${index}`, model: MODEL });
    }
    assert.equal(sidebar.summary()!.items.length, MAX_OPEN_CONVERSATIONS);
    const before = sidebar.posted.length;
    await sidebar.send({ type: 'new-chat' });
    assert.equal(sidebar.summary()!.items.length, MAX_OPEN_CONVERSATIONS, 'no ninth');
    assert.ok(since(sidebar.posted, before).some((message) => message.type === 'notice' && /8 conversations are open, the most at once\. Close one/.test(String(message.text))));
  });
});

test('sidebar: a reload reopens the conversation list, and a run it cut off shows as stopped in the chat and in Agent Activity history', async () => {
  const { root, auth, shared } = await projectWithProfile();
  // What the previous extension host left: two open conversations, one of them mid-run.
  const transcripts = threadStoreFor(root, shared.secrets as never, 'testseed.1');
  const cut = 'conv-cut000-0a0b0c0d';
  const done = 'conv-done00-0e0f1a1b';
  await transcripts.save({ id: cut, title: 'Migrate the database', model: MODEL, updatedAt: new Date().toISOString(), turns: 1, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Migrate the database' }] });
  await transcripts.save({ id: done, title: 'Explain the build', model: MODEL, updatedAt: new Date().toISOString(), turns: 1, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Explain the build' }, { role: 'assistant', content: 'It uses tsc.' }] });
  const activity = new ActivityStore(root);
  const session = await activity.start({ project: 'demo', runId: 'run-1-cccccc', conversationId: cut, title: 'Migrate the database', summary: 'Agent conversation turn started.' });
  await shared.workspaceState.update('nearAi.chat.openConversations', { activeId: done, items: [{ id: cut, title: 'Migrate the database', status: 'running' }, { id: done, title: 'Explain the build', status: 'done' }] });

  const near = fakeNear((messages) => ({ content: `Saw: ${lastUser(messages)}` }));
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const list = sidebar.summary()!;
    assert.equal(list.activeId, done);
    assert.deepEqual(list.items.map((item) => [item.id, item.title, item.status]), [[cut, 'Migrate the database', 'stopped'], [done, 'Explain the build', 'done']]);
    const shownDone = sidebar.posted.filter((message) => message.type === 'transcript');
    assert.deepEqual((shownDone.at(-1)!.turns as Array<{ role: string; text: string }>).map((turn) => turn.text), ['Explain the build', 'It uses tsc.']);

    const before = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: cut });
    const shownCut = since(sidebar.posted, before);
    assert.deepEqual((shownCut.find((message) => message.type === 'transcript')!.turns as Array<{ text: string }>).map((turn) => turn.text), ['Migrate the database'], 'its transcript is kept');
    assert.ok(shownCut.some((message) => message.type === 'notice' && /stopped when VS Code reloaded/.test(String(message.text))));

    const closed = await new ActivityStore(root).get(session.sessionId);
    assert.equal(closed?.runOutcome, 'cancelled');
    assert.equal(historyPage(await new ActivityStore(root).list(), 0).rows[0].outcome, 'cancelled', 'Agent Activity history shows it stopped, not running');

    // Continuing it sends its full context: the same conversation, now with the new message.
    await sidebar.send({ type: 'send', text: 'continue please', model: MODEL, conversationId: cut });
    assert.deepEqual(near.requests.at(-1)!.filter((message) => message.role === 'user').map((message) => message.content), ['Migrate the database', 'continue please']);
    const sessions = await new ActivityStore(root).list();
    assert.equal(sessions.filter((entry) => entry.conversationId === cut).length, 2, 'the new run is in the same conversation window');
  });
});

test('sidebar: a conversation stopped or closed while its turn is still being prepared never starts its run', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const near = fakeNear(() => ({ content: 'should not run' }));
  // The model catalog is held, so each turn is still being prepared when it is stopped.
  let releaseCatalog!: () => void;
  let catalogAsked = false;
  let holding = false;
  const catalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  const held = (async (input: string | URL | Request, init?: RequestInit) => {
    if (holding && String(input).endsWith('/models')) { catalogAsked = true; await catalog; }
    return near.fetch(input, init);
  }) as typeof globalThis.fetch;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = held;
  try {
    const sidebar = await openSidebar(root, auth, shared);
    // The catalog loaded for the model list is cached; the turn loads it afresh.
    (require('../services/providerCache') as typeof import('../services/providerCache')).clearProviderCache();
    holding = true;
    const a = sidebar.summary()!.activeId;
    const first = sidebar.send({ type: 'send', text: 'first', model: MODEL, conversationId: a });
    await until(() => catalogAsked);
    assert.equal(sidebar.item(a)?.status, 'running');
    await sidebar.send({ type: 'stop', conversationId: a });
    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;
    const second = sidebar.send({ type: 'send', text: 'second', model: MODEL, conversationId: b });
    confirmClose = 'Stop and close';
    await sidebar.send({ type: 'close-conversation', id: b });
    releaseCatalog();
    await Promise.all([first, second]);
    assert.equal(near.requests.length, 0, 'no model request was made');
    assert.equal(sidebar.item(a)?.status, 'stopped');
    assert.equal(sidebar.item(b), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- 0.4.11: a run cut off by code-server or a reload is reported and can be resumed; waiting prompts are noticed. ---

/** The marker a run left in the extension's storage, rewritten as if its extension host had died. */
/** A reader that is this test process's editor, in a new extension host, as a window opened after a reload would be. */
function sameEditorMarkers(root: string): RunMarkers {
  return new RunMarkers('', root, { dir: stateHomeFor(root).paths.runs, writer: `${writerEditor(editorWriter())}.reader000` });
}

function killHost(root: string, conversationId: string, steps?: string[]): Record<string, unknown> {
  const file = path.join(stateHomeFor(root).paths.runs, `${conversationId}.json`);
  const marker = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // The extension host is gone: the same editor's next host has another instance id, and the old pid no longer exists.
  const dead = { ...marker, pid: 2_147_483_646, writer: `${writerEditor(String(marker.writer))}.deadhost0`, ...(steps ? { steps } : {}) };
  writeFileSync(file, JSON.stringify(dead));
  return marker;
}

test('sidebar: a run the extension host never finished is reported with Resume, which continues from its saved state and names the step that may not have completed', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const readCall: Delta = { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"app.ts"}' } }] };
  const near = fakeNear(async (messages) => {
    if (!messages.some((message) => message.role === 'tool')) return readCall;
    if (!lastUser(messages).startsWith('Continue the task')) await gate.hold('long refactor');
    return { content: 'Checked app.ts and finished the refactor.' };
  });
  await withNear(near, async () => {
    const first = await openSidebar(root, auth, shared);
    const a = first.summary()!.activeId;
    void first.send({ type: 'send', text: 'long refactor', model: MODEL, conversationId: a });
    await until(() => gate.holding('long refactor'));
    // The run saved its state after the Read finished, and recorded that it is running.
    const marker = killHost(root, a, ['Edit']);
    assert.equal(marker.runId !== undefined && marker.endedAt === undefined, true);
    assert.equal(typeof marker.savedAt, 'string', 'the state after each finished step is saved');
    assert.deepEqual(marker.steps, [], 'no step was started after the last save');
    assert.equal(JSON.stringify(marker).includes('long refactor'), false, 'the marker holds no prompt');

    // code-server killed the extension host, and the window's own list of open conversations was lost.
    const second = await openSidebar(root, auth, { secrets: shared.secrets, workspaceState: new Memento() });
    assert.equal(second.summary()!.activeId, a, 'the cut-off conversation is opened and shown');
    assert.equal(second.item(a)?.status, 'stopped');
    const cut = second.posted.find((message) => message.type === 'run-interrupted');
    assert.ok(cut, 'the chat says the run was cut off');
    assert.match(String(cut.text), /^This run was cut off \(the window or code-server closed it\) at .+\.$/);
    assert.equal(cut.resumable, true);
    assert.deepEqual(shownTexts(second.posted.find((message) => message.type === 'transcript')!)[0], 'long refactor');
    assert.equal(second.posted.some((message) => message.type === 'notice' && /stopped when VS Code reloaded/.test(String(message.text))), false, 'one message, not two');
    assert.equal(near.requests.length, 2, 'nothing is resumed until the user clicks Resume');

    await second.send({ type: 'resume-interrupted', conversationId: a });
    await until(() => second.item(a)?.status === 'done');
    const resumed = near.requests.at(-1)!;
    assert.equal(near.requests.length, 3);
    assert.equal(firstUser(resumed), 'long refactor', 'the same conversation');
    assert.ok(resumed.some((message) => message.role === 'tool' && String(message.content).includes('export const port = 3000;')), 'with the step that finished before the cut');
    assert.match(lastUser(resumed), /^Continue the task\. Your previous run was cut off at /);
    assert.match(lastUser(resumed), /this step: Edit\. Its result was never recorded/);
    assert.deepEqual(await sameEditorMarkers(root).interrupted(), [], 'resumed: not reported again');

    // A second click does nothing; a later window does not report it again.
    await second.send({ type: 'resume-interrupted', conversationId: a });
    assert.equal(near.requests.length, 3);
    const third = await openSidebar(root, auth, { secrets: shared.secrets, workspaceState: new Memento() });
    assert.equal(third.posted.some((message) => message.type === 'run-interrupted'), false);

    await first.send({ type: 'stop', conversationId: a });
    gate.release('long refactor');
  });
});

test('sidebar: with nearAi.agent.autoResumeAfterReload on, a cut-off run carries on by itself with a notice, keeping the step that finished', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const readCall: Delta = { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"app.ts"}' } }] };
  const near = fakeNear(async (messages) => {
    if (!messages.some((message) => message.role === 'tool')) return readCall;
    if (!lastUser(messages).startsWith('Continue the task')) await gate.hold('long refactor');
    return { content: 'Checked app.ts and finished the refactor.' };
  });
  autoResume.on = true;
  try {
    await withNear(near, async () => {
      const first = await openSidebar(root, auth, shared);
      const a = first.summary()!.activeId;
      void first.send({ type: 'send', text: 'long refactor', model: MODEL, conversationId: a });
      await until(() => gate.holding('long refactor'));
      killHost(root, a, ['Edit']);
      const second = await openSidebar(root, auth, { secrets: shared.secrets, workspaceState: new Memento() });
      await until(() => near.requests.some((request) => lastUser(request).startsWith('Continue the task')));
      assert.ok(second.posted.some((message) => message.type === 'notice' && /^Resuming automatically: this run was cut off by a reload/.test(String(message.text))), 'the conversation says it resumed by itself');
      const resumed = near.requests.find((request) => lastUser(request).startsWith('Continue the task'))!;
      assert.ok(resumed.some((message) => message.role === 'tool' && String(message.content).includes('export const port = 3000;')), 'the finished Read is kept, not run again');
      assert.equal(near.requests.filter((request) => !request.some((message) => message.role === 'tool')).length, 1, 'the first step was never asked for again');
      await until(() => second.item(a)?.status !== 'running');
      assert.deepEqual(await sameEditorMarkers(root).interrupted(), [], 'resumed: not reported again');
      gate.release('long refactor');
    });
  } finally {
    autoResume.on = false;
  }
});

test('sidebar: with the emergency stop on (#36), a cut-off run does not resume by itself even with auto-resume on, and keeps its Resume button', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const gate = gates();
  const readCall: Delta = { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"app.ts"}' } }] };
  const near = fakeNear(async (messages) => {
    if (!messages.some((message) => message.role === 'tool')) return readCall;
    if (!lastUser(messages).startsWith('Continue the task')) await gate.hold('long refactor');
    return { content: 'Checked app.ts and finished the refactor.' };
  });
  const { setEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
  autoResume.on = true;
  try {
    await withNear(near, async () => {
      const first = await openSidebar(root, auth, shared);
      const a = first.summary()!.activeId;
      void first.send({ type: 'send', text: 'long refactor', model: MODEL, conversationId: a });
      await until(() => gate.holding('long refactor'));
      // The stop is pressed; this test's first window is still alive, so it ends its own run. The host that ran it is then treated as gone with
      // the run cut off, as a reload during the stop would leave it.
      await setEmergencyStop(true);
      await until(() => first.item(a)?.status === 'stopped');
      const file = path.join(stateHomeFor(root).paths.runs, `${a}.json`);
      await until(() => (JSON.parse(readFileSync(file, 'utf8')).endedAt ? true : undefined));
      const ended = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      delete ended.endedAt;
      delete ended.outcome;
      writeFileSync(file, JSON.stringify({ ...ended, pid: 2_147_483_646, writer: `${writerEditor(String(ended.writer))}.deadhost0`, steps: ['Edit'] }));
      const second = await openSidebar(root, auth, { secrets: shared.secrets, workspaceState: new Memento() });
      await until(() => second.posted.find((message) => message.type === 'notice' && /^Not resumed automatically: the emergency stop is on/.test(String(message.text))));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(near.requests.some((request) => lastUser(request).startsWith('Continue the task')), false, 'nothing was resumed');
      assert.ok(second.posted.some((message) => message.type === 'run-interrupted' && message.resumable === true), 'the Resume button stays');
      assert.equal((await sameEditorMarkers(root).interrupted()).length, 1, 'the cut-off run is still there to resume later');
      gate.release('long refactor');
    });
  } finally {
    await setEmergencyStop(false);
    autoResume.on = false;
  }
});

test('sidebar: Dismiss settles a cut-off run without running anything; a cut-off run with no saved transcript is not reopened', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const cut = 'conv-dism00-0a0b0c0d';
  const lost = 'conv-lost00-0a0b0c0d';
  const transcripts = threadStoreFor(root, shared.secrets as never, 'testseed.1');
  await transcripts.save({ id: cut, title: 'Write the report', model: MODEL, updatedAt: new Date().toISOString(), turns: 1, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Write the report' }] });
  const dead = new RunMarkers('', root, { dir: stateHomeFor(root).paths.runs, pid: 2_147_483_646, writer: `${writerEditor(editorWriter())}.deadhost0` });
  await dead.start({ conversationId: cut, runId: 'run-1-dddddd', model: MODEL });
  await dead.start({ conversationId: lost, runId: 'run-2-eeeeee', model: MODEL });
  await shared.workspaceState.update('nearAi.chat.openConversations', { activeId: cut, items: [{ id: cut, title: 'Write the report', status: 'running' }] });
  const near = fakeNear(() => ({ content: 'should not run' }));
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    assert.deepEqual(sidebar.summary()!.items.map((item) => item.id), [cut], 'no tab for a conversation that was never saved');
    assert.ok(sidebar.posted.some((message) => message.type === 'run-interrupted' && message.resumable === true));
    assert.equal(sidebar.posted.some((message) => message.type === 'notice' && /stopped when VS Code reloaded/.test(String(message.text))), false);
    const before = sidebar.posted.length;
    await sidebar.send({ type: 'dismiss-interrupted', conversationId: cut });
    assert.ok(since(sidebar.posted, before).some((message) => message.type === 'run-interrupted-settled' && message.outcome === 'dismissed'));
    assert.equal(near.requests.length, 0);
    // Shown again, the conversation no longer offers Resume.
    const again = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: cut });
    assert.equal(since(sidebar.posted, again).some((message) => message.type === 'run-interrupted'), false);
    assert.deepEqual((await sameEditorMarkers(root).interrupted()).map((marker) => marker.conversationId), [lost]);
  });
});

test('sidebar: a waiting approval is announced when the window is not focused, and on focus for one that was not, once per prompt', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const near = fakeNear((messages) => messages.some((message) => message.role === 'tool') ? { content: 'done' } : editCall);
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    const announced = () => warnings.filter((text) => /is waiting for your approval/.test(text)).length;
    const start = announced();
    // The browser tab is in the background: the chat counts as visible, but the window has no focus.
    vscodeStub.window.state.focused = false;
    const runA = sidebar.send({ type: 'send', text: 'edit while away', model: MODEL, conversationId: a });
    await until(() => sidebar.item(a)?.status === 'waiting');
    assert.equal(announced(), start + 1);
    // Back in the window: that prompt was already announced.
    vscodeStub.window.state.focused = true;
    for (const listener of windowListeners) listener({ focused: true });
    assert.equal(announced(), start + 1, 'never twice for the same prompt');

    // A prompt that opens while the user is looking is not announced, until the window loses and regains focus.
    await sidebar.send({ type: 'new-chat' });
    const b = sidebar.summary()!.activeId;
    const runB = sidebar.send({ type: 'send', text: 'edit while here', model: MODEL, conversationId: b });
    await until(() => sidebar.item(b)?.status === 'waiting');
    assert.equal(announced(), start + 1);
    for (const listener of windowListeners) listener({ focused: false });
    assert.equal(announced(), start + 1, 'losing focus announces nothing');
    for (const listener of windowListeners) listener({ focused: true });
    assert.equal(announced(), start + 2);
    assert.match(warnings.at(-1)!, /"edit while here" is waiting for your approval/);
    for (const listener of windowListeners) listener({ focused: true });
    assert.equal(announced(), start + 2, 'once per prompt');
    assert.deepEqual(sidebar.view.badge, { value: 2, tooltip: 'NEAR AI is waiting for you in 2 conversations' }, 'the badge stays');

    await sidebar.send({ type: 'approval-reply', callId: 'call_edit', decision: 'deny', conversationId: a });
    await sidebar.send({ type: 'approval-reply', callId: 'call_edit', decision: 'deny', conversationId: b });
    await Promise.all([runA, runB]);
  });
});

// --- 0.4.12: a run stopped short says why, honestly, and offers Continue. ---

const readCallNumbered = (n: number, file = 'app.ts'): Delta => ({ tool_calls: [{ index: 0, id: `call_read_${n}`, function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) } }] });
const assistantTurns = (messages: Wire) => messages.filter((message) => message.role === 'assistant').length;

test('sidebar: an agent stuck repeating the same read is stopped with an honest message and a Continue button that sends "Continue." only when clicked', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const near = fakeNear((messages) => (lastUser(messages) === 'Continue.' ? { content: 'Read the error and fixed it.' } : readCallNumbered(assistantTurns(messages))));
  await withNear(near, async () => {
    const sidebar = await openSidebar(root, auth, shared);
    const a = sidebar.summary()!.activeId;
    await sidebar.send({ type: 'send', text: 'check the port', model: MODEL, conversationId: a });
    const stopped = sidebar.posted.filter((message) => message.type === 'run-stopped');
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].text, 'Stopped: the agent kept repeating Read app.ts with the same result.');
    assert.equal(stopped[0].reason, 'loop');
    assert.equal(stopped[0].continuable, true);
    const said = sidebar.posted.filter((message) => message.type === 'assistant-delta').map((message) => String(message.text)).join('');
    assert.doesNotMatch(said, /turn limit/, 'a loop stop is not called a turn limit');
    assert.equal(sidebar.item(a)?.status, 'stopped');
    const before = near.requests.length;
    assert.ok(before >= 14 && before <= 16, `stopped after the warning, not at the turn limit (${before} requests)`);
    assert.ok(near.requests.at(-1)!.some((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>Warning:')), 'warned before it was stopped');
    assert.equal(near.requests.some((messages) => lastUser(messages) === 'Continue.'), false, 'nothing continues on its own');

    const clicked = sidebar.posted.length;
    await sidebar.send({ type: 'continue-run', conversationId: a });
    await until(() => sidebar.item(a)?.status === 'done');
    assert.deepEqual(since(sidebar.posted, clicked).find((message) => message.type === 'user-turn'), { type: 'user-turn', text: 'Continue.' }, 'the click shows the message it sends');
    assert.equal(near.requests.length, before + 1);
    assert.equal(lastUser(near.requests.at(-1)!), 'Continue.');
    assert.equal(firstUser(near.requests.at(-1)!), 'check the port', 'the same conversation, with its context');

    // Used once: a second click does nothing, and shown again the notice has no button.
    await sidebar.send({ type: 'continue-run', conversationId: a });
    assert.equal(near.requests.length, before + 1);
    const shown = sidebar.posted.length;
    await sidebar.send({ type: 'switch-conversation', id: a });
    const replayed = since(sidebar.posted, shown).filter((message) => message.type === 'run-stopped');
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].continuable, false);
  });
});

test('sidebar: the real turn limit names the limit and offers Continue; typing a message instead settles the offer', async () => {
  const { root, auth, shared } = await projectWithProfile();
  const original = vscodeStub.workspace.getConfiguration;
  vscodeStub.workspace.getConfiguration = () => ({ get: (key: string, fallback?: unknown) => (key === 'agent.maxTurns' ? 5 : fallback), inspect: () => undefined });
  // Varied, productive work: a different file each turn.
  for (let index = 0; index < 8; index += 1) await writeFile(path.join(root, `part${index}.ts`), `export const part = ${index};\n`);
  const near = fakeNear((messages) => (lastUser(messages) === 'go on' ? { content: 'Finished the rest.' } : readCallNumbered(assistantTurns(messages), `part${assistantTurns(messages)}.ts`)));
  try {
    await withNear(near, async () => {
      const sidebar = await openSidebar(root, auth, shared);
      const a = sidebar.summary()!.activeId;
      await sidebar.send({ type: 'send', text: 'read every part', model: MODEL, conversationId: a });
      assert.equal(near.requests.length, 5);
      const stopped = sidebar.posted.find((message) => message.type === 'run-stopped');
      assert.equal(stopped?.text, 'Stopped after reaching the turn limit (5 turns).');
      assert.equal(stopped?.reason, 'turn-limit');
      assert.equal(stopped?.continuable, true);
      assert.equal(sidebar.posted.some((message) => /Send a message to continue/.test(String(message.text))), false, 'the old sentence is gone');

      await sidebar.send({ type: 'send', text: 'go on', model: MODEL, conversationId: a });
      await until(() => sidebar.item(a)?.status === 'done');
      const after = near.requests.length;
      await sidebar.send({ type: 'continue-run', conversationId: a });
      assert.equal(near.requests.length, after, 'a message typed instead settles the offer');
    });
  } finally {
    vscodeStub.workspace.getConfiguration = original;
  }
});

test('the Continue button and its message are wired in the view and parsed strictly', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'continue-run', conversationId: 'conv-mf3k2-0a1b2c3d' }), { type: 'continue-run', conversationId: 'conv-mf3k2-0a1b2c3d' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'continue-run' }), { type: 'continue-run' });
  assert.equal(parseChatWebviewMessage({ type: 'continue-run', text: 'rm -rf /' }), undefined);
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /case 'run-stopped': \{[\s\S]*?textButton\('Continue', \(\) => settleContinue\(true\), true\)/);
  assert.match(script, /postFor\(\{ type: 'continue-run' \}\)/);
  assert.match(script, /case 'assistant-start': settleContinue\(false\);/, 'a new turn removes the button');
});
