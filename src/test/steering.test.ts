import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun, RunInput } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { AuthService, SecretStorageLike } from '../services/auth';
import { MAX_MESSAGE_CHARS, parseChatWebviewMessage } from '../services/chatBridge';
import { ProfileStore } from '../services/profileStore';
import { deriveProfileId } from '../domain/auth';
import type { AgentMessage, CompletionEvent } from '../services/nearAiClient';

// Steering: a message typed while a run is going is queued for the running agent, appended to its
// transcript before the next model request (never mid-stream or mid-tool), ends a retry wait, and
// becomes a new turn if the run ended first. Stop still stops, and an idle send is unchanged.

const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };

/** A RunInput backed by an array, as AgentConversation provides one. */
function queue() {
  const items: string[] = [];
  const listeners = new Set<(notice: { interrupt: boolean }) => void>();
  const input: RunInput = {
    pending: () => items.length > 0,
    take: () => items.splice(0).map((text) => ({ role: 'user' as const, content: text })),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  return { input, push: (text: string, options: { interrupt?: boolean } = {}) => { items.push(text); for (const listener of [...listeners]) listener({ interrupt: options.interrupt === true }); } };
}

const userTexts = (messages: AgentMessage[]) => messages.filter((message) => message.role === 'user').map((message) => String(message.content));

test('the bridge parses steer strictly', () => {
  const id = 'steer-0123456789ab';
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id, text: '  use port 8080 ' }), { type: 'steer', id, text: 'use port 8080' });
  assert.ok(parseChatWebviewMessage({ type: 'steer', id, text: 'x'.repeat(MAX_MESSAGE_CHARS) }));
  // 0.4.18 review: a Steer carries `interrupt`, and the parser must accept it; before this the button sent a message the host threw away.
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id, text: 'stop that', interrupt: true }), { type: 'steer', id, text: 'stop that', interrupt: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id, text: 'stop that' }), { type: 'steer', id, text: 'stop that' }, 'a queue is unchanged');
  assert.equal(parseChatWebviewMessage({ type: 'steer', id, text: 'stop that', interrupt: 'yes' }), undefined, 'interrupt is a boolean');
  for (const bad of [
    { type: 'steer', id, text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) },
    { type: 'steer', id, text: '   ' },
    { type: 'steer', id, text: 42 },
    { type: 'steer', text: 'hi' },
    { type: 'steer', id: 'steer-XYZ', text: 'hi' },
    { type: 'steer', id: 'steer-0123456789abc', text: 'hi' },
    { type: 'steer', id, text: 'hi', model: 'm' },
    { type: 'steer', id, text: 'hi', attachmentIds: ['att-0123456789ab'] }
  ]) assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad).slice(0, 80));
});

test('a message queued during a model turn is appended after its tool calls and before the next request, in order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-steer-loop-'));
  await writeFile(path.join(root, 'a.ts'), 'a');
  const { input, push } = queue();
  const seen: AgentMessage[][] = [];
  let toolRan = false;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      if (seen.length === 1) {
        // Both arrive while the reply streams; neither cuts it off.
        yield { type: 'text', text: 'Reading.' };
        push('first: use port 8080');
        push('second: and add a test');
        yield { type: 'done', message: { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] }, finishReason: 'tool_calls', usage };
        return;
      }
      assert.ok(toolRan, 'the tool call finished before the next request');
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    }
  };
  const run = new AgentRun({
    client, model: 'm', tools: [{ name: 'Read', description: 'read', parameters: {}, capability: 'read', parse: (raw: unknown) => raw, title: () => 'Read a.ts', run: async () => { toolRan = true; return 'a'; } } as never],
    context: { root, checkpoints: new RunCheckpoints('steer'), readFiles: new Set() } as never,
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, input,
    requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined
  });
  const result = await run.run([{ role: 'user', content: 'start' }], new AbortController().signal);
  assert.equal(result.outcome, 'completed');
  assert.equal(seen.length, 2);
  const second = seen[1];
  assert.deepEqual(second.slice(-4).map((message) => message.role), ['assistant', 'tool', 'user', 'user'], 'after the tool result, before the next request');
  assert.deepEqual(userTexts(second).slice(-2), ['first: use port 8080', 'second: and add a test'], 'queued in order');
});

test('a message that arrives while the final answer streams keeps the run going', async () => {
  const { input, push } = queue();
  const seen: AgentMessage[][] = [];
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      seen.push([...messages]);
      if (seen.length === 1) push('actually, use TypeScript');
      yield { type: 'done', message: { role: 'assistant', content: `answer ${seen.length}` }, finishReason: 'stop', usage };
    }
  };
  const run = new AgentRun({ client, model: 'm', tools: [], context: { root: tmpdir(), checkpoints: new RunCheckpoints('steer'), readFiles: new Set() } as never, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, input, requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined });
  const result = await run.run([{ role: 'user', content: 'start' }], new AbortController().signal);
  assert.equal(seen.length, 2);
  assert.equal(userTexts(seen[1]).at(-1), 'actually, use TypeScript');
  assert.equal(result.messages.at(-1)?.content, 'answer 2');
});

test('a message during a retry wait ends the wait, and the next attempt carries it', async () => {
  const { input, push } = queue();
  const seen: AgentMessage[][] = [];
  const events: string[] = [];
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      seen.push([...messages]);
      if (seen.length === 1) throw Object.assign(new Error('NEAR AI is busy.'), { retryable: true, status: 503 });
      yield { type: 'done', message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage };
    }
  };
  let waits = 0;
  // A wait that only ends when its signal aborts: the run finishing proves the message ended it.
  const sleep = (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { waits += 1; setTimeout(() => push('try the other endpoint'), 5); signal.addEventListener('abort', () => resolve(), { once: true }); });
  const run = new AgentRun({ client, model: 'm', tools: [], context: { root: tmpdir(), checkpoints: new RunCheckpoints('steer'), readFiles: new Set() } as never, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, input, sleep, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event.type) });
  const result = await run.run([{ role: 'user', content: 'start' }], new AbortController().signal);
  assert.equal(result.outcome, 'completed');
  assert.equal(waits, 1);
  assert.ok(events.includes('retry'));
  assert.equal(userTexts(seen[1]).at(-1), 'try the other endpoint');
});

test('a request held by the model\'s cooldown is re-sent with a message that arrives meanwhile', async () => {
  const { input, push } = queue();
  const seen: AgentMessage[][] = [];
  let cooling = true;
  const client = {
    cooldownRemainingMs: () => cooling ? 30_000 : 0,
    async *streamCompletion(_model: string, messages: AgentMessage[], _tools: unknown, signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      seen.push([...messages]);
      if (seen.length === 1) {
        // The client waits out the cooldown before sending anything.
        setTimeout(() => push('skip the migration'), 5);
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      }
      cooling = false;
      yield { type: 'done', message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage };
    }
  };
  const run = new AgentRun({ client, model: 'm', tools: [], context: { root: tmpdir(), checkpoints: new RunCheckpoints('steer'), readFiles: new Set() } as never, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, input, requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined });
  const result = await run.run([{ role: 'user', content: 'start' }], new AbortController().signal);
  assert.equal(result.outcome, 'completed');
  assert.equal(seen.length, 2);
  assert.equal(userTexts(seen[1]).at(-1), 'skip the migration');
});

// --- The sidebar host path: the real chat.ts handler, AgentConversation, and NearAiClient against a fake NEAR. ---

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const vscodeStub = {
  workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }>, name: 'demo', getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback, inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showInformationMessage: () => undefined, showWarningMessage: () => undefined, activeTextEditor: undefined },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

async function openSidebar(root: string, auth: AuthService) {
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const view = {
    webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} })
  };
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try {
    const { attachChatToView } = require('../services/chat') as typeof import('../services/chat');
    await attachChatToView({ subscriptions: [], globalStorageUri: { fsPath: path.join(root, '.global') }, extensionUri: { fsPath: root } } as never, auth, view as never, '<html></html>');
  } finally {
    nodeModule._load = originalLoad;
  }
  return { posted, send: (message: unknown) => receive!(message) };
}

async function projectWithProfile() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-steer-'));
  const auth = new AuthService(new MemorySecrets());
  const profiles = new ProfileStore(root, auth, { validator: async () => undefined });
  await profiles.configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  await writeFile(path.join(root, 'app.ts'), 'export const port = 3000;\n');
  return { root, auth };
}

type Delta = { content?: string; tool_calls?: Array<{ index: number; id: string; function: { name: string; arguments: string } }> };

/** A fake NEAR whose chat turns come from `next`, which sees each request's messages. */
function fakeNear(next: (messages: Array<{ role: string; content: unknown }>) => Promise<Delta> | Delta, hooks: { billing?: () => Promise<void> } = {}) {
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/models/pricing')) return new Response('{}', { status: 404 });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1, output: 1 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }] });
    if (url.endsWith('/billing/costs')) { await hooks.billing?.(); return Response.json({ requests: [{ requestId: '0b6e3f9e-5a1d-5c2b-8f4e-1d2c3b4a5f60', costNanoUsd: 1000 }] }); }
    if (url.endsWith('/chat/completions')) {
      const messages = JSON.parse(String(init?.body)).messages as Array<{ role: string; content: unknown }>;
      requests.push(messages);
      const delta = await next(messages);
      const body = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}', 'data: [DONE]', ''].join('\n\n');
      return new Response(body, { status: 200, headers: { 'inference-id': '0b6e3f9e-5a1d-5c2b-8f4e-1d2c3b4a5f60' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

const lastUser = (messages: Array<{ role: string; content: unknown }>) => String(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '');
const steerStates = (posted: Array<Record<string, unknown>>, id: string) => posted.filter((message) => message.type === 'steer-state' && message.id === id).map((message) => message.state);
const editCall: Delta = { tool_calls: [{ index: 0, id: 'call_edit', function: { name: 'Edit', arguments: '{"file_path":"app.ts","old_string":"3000","new_string":"8080"}' } }] };

test('sidebar: a message sent while a tool waits for approval is queued, then delivered before the next model request', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear((messages) => near.requests.length === 1 ? editCall : { content: `Saw: ${lastUser(messages)}` });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    const approval = await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    await sidebar.send({ type: 'steer', id: 'steer-aaaaaaaaaaaa', text: 'Also keep a comment' });
    await sidebar.send({ type: 'steer', id: 'steer-bbbbbbbbbbbb', text: 'and update the README' });
    assert.deepEqual(steerStates(sidebar.posted, 'steer-aaaaaaaaaaaa'), ['queued']);
    assert.equal(near.requests.length, 1, 'the running tool is not interrupted');
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    assert.equal(near.requests.length, 2, 'one run: the steer did not start a turn of its own');
    const second = near.requests[1];
    const users = second.filter((message) => message.role === 'user').map((message) => String(message.content));
    assert.match(users.at(-2)!, /<user-message-during-run>\nAlso keep a comment\n<\/user-message-during-run>/);
    assert.match(users.at(-1)!, /and update the README/);
    assert.match(users.at(-1)!, /takes precedence over your current plan/);
    assert.equal(second.at(-3)?.role, 'tool', 'after the tool result');
    assert.deepEqual(steerStates(sidebar.posted, 'steer-aaaaaaaaaaaa'), ['queued', 'delivered']);
    assert.deepEqual(steerStates(sidebar.posted, 'steer-bbbbbbbbbbbb'), ['queued', 'delivered']);
    assert.match(String(second[0].content), /<user-message-during-run>/, 'the system prompt explains such messages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: a message that arrives after the run ended becomes a new turn', async () => {
  const { root, auth } = await projectWithProfile();
  let releaseBilling!: () => void;
  let billingReached = false;
  const billingGate = new Promise<void>((resolve) => { releaseBilling = resolve; });
  const near = fakeNear((messages) => ({ content: `Saw: ${lastUser(messages)}` }), { billing: async () => { if (!billingReached) { billingReached = true; await billingGate; } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    // The run's answer is done, but the turn is still settling its cost: the message is queued and no run takes it.
    const running = sidebar.send({ type: 'send', text: 'hello', model: 'z-ai/glm-5.3' });
    await until(() => billingReached);
    await sidebar.send({ type: 'steer', id: 'steer-cccccccccccc', text: 'one more thing' });
    assert.deepEqual(steerStates(sidebar.posted, 'steer-cccccccccccc'), ['queued']);
    releaseBilling();
    await running;
    assert.deepEqual(steerStates(sidebar.posted, 'steer-cccccccccccc'), ['queued', 'sent-new']);
    assert.equal(near.requests.length, 2);
    assert.equal(lastUser(near.requests[1]), 'one more thing', 'sent as an ordinary message');
    assert.equal(sidebar.posted.filter((message) => message.type === 'assistant-start').length, 2);

    // With nothing running at all, a steer is simply a new message.
    await sidebar.send({ type: 'steer', id: 'steer-dddddddddddd', text: 'and another' });
    assert.deepEqual(steerStates(sidebar.posted, 'steer-dddddddddddd'), ['sent-new']);
    assert.equal(near.requests.length, 3);
    assert.equal(lastUser(near.requests[2]), 'and another');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: stop still stops the run, and a queued message goes back to the composer', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear(() => near.requests.length === 1 ? editCall : { content: 'should not happen' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    await sidebar.send({ type: 'steer', id: 'steer-eeeeeeeeeeee', text: 'never mind' });
    await sidebar.send({ type: 'stop' });
    await running;
    assert.ok(sidebar.posted.some((message) => message.type === 'assistant-cancelled'));
    const returned = sidebar.posted.find((message) => message.type === 'steer-state' && message.state === 'returned');
    assert.deepEqual(returned, { type: 'steer-state', id: 'steer-eeeeeeeeeeee', state: 'returned', text: 'never mind' });
    assert.equal(near.requests.length, 1, 'nothing more is sent after stop');
    assert.equal(sidebar.posted.filter((message) => message.type === 'assistant-start').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: a message with a credential is not sent to the running agent', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear(() => near.requests.length === 1 ? editCall : { content: 'done' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    const approval = await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    await sidebar.send({ type: 'steer', id: 'steer-ffffffffffff', text: 'use api_key=sk-live-999' });
    const blocked = sidebar.posted.find((message) => message.type === 'steer-state' && message.id === 'steer-ffffffffffff');
    assert.equal(blocked?.state, 'blocked');
    assert.match(String(blocked?.reason), /credential/);
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    assert.equal(near.requests.some((messages) => JSON.stringify(messages).includes('sk-live-999')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: sending while idle is unchanged', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear(() => ({ content: 'Hello' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    await sidebar.send({ type: 'send', text: 'Say hello', model: 'z-ai/glm-5.3' });
    assert.equal(near.requests.length, 1);
    assert.equal(lastUser(near.requests[0]), 'Say hello');
    assert.ok(sidebar.posted.some((message) => message.type === 'assistant-done'));
    assert.equal(sidebar.posted.some((message) => message.type === 'steer-state'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the composer keeps Send during a run, with a separate Stop button and Esc to stop', () => {
  const view = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  // 0.4.18: a Steer button sits between Stop and Send, hidden until a run is going, so the interrupt is a control a person can find.
  assert.match(view, /<button id="stop" class="icon-button" type="button" aria-label="Stop" title="Stop the run \(Esc in an empty message box\)" hidden><\/button>\s*<button id="steer"[^>]*hidden>Steer<\/button>\s*<button id="send"/);
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.doesNotMatch(script, /if \(busy\) \{ post\(\{ type: 'stop' \}\)/, 'Enter no longer stops the run');
  assert.match(script, /function updateSendState\(\) \{ send\.disabled = !input\.value\.trim\(\); \}/, 'Send depends only on there being text');
  assert.match(script, /event\.key === 'Escape' && busy && !input\.value\.trim\(\)/);
  assert.match(script, /if \(busy && !command\) \{ sendSteer\(text\); return; \}/);
  assert.match(script, /Finish or stop the current run first/);
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(css, /\.composer \.bar \.icon-button \{ flex: none; \}/, 'both buttons keep their size at narrow widths');
});

// ---- 0.4.18: Steer interrupts the reply in flight (owner, 2026-11-06: "a message sent is still only queued") ---------------------------
// The old cut only fired before anything had streamed and only while the model was cooling down from a rate limit, so in normal use a message could
// only ever queue. A Steer is an explicit request, so it cuts whatever has already streamed.

function interruptingQueue() {
  const items: string[] = [];
  const listeners = new Set<(notice: { interrupt: boolean }) => void>();
  let interrupts = 0;
  const input: RunInput = {
    pending: () => items.length > 0,
    take: () => { interrupts = 0; return items.splice(0).map((text) => ({ role: 'user' as const, content: text })); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    interruptRequested: () => interrupts > 0
  };
  return {
    input,
    push: (text: string, options: { interrupt?: boolean } = {}) => {
      items.push(text);
      if (options.interrupt) interrupts += 1;
      for (const listener of [...listeners]) listener({ interrupt: options.interrupt === true });
    }
  };
}

test('a Steer pressed while the reply is streaming cuts it at once, and the message becomes the next request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-steer-cut-'));
  const { input, push } = interruptingQueue();
  const seen: AgentMessage[][] = [];
  let streamed = 0;
  const client = {
    // A normal model with no cooldown: `cooldownRemainingMs` returns 0, so the old "only before anything streamed, only while cooling down" cut
    // could never fire here. Only the explicit Steer can end this reply early.
    cooldownRemainingMs: () => 0,
    async *streamCompletion(_model: string, messages: AgentMessage[], _tools: unknown, signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      if (seen.length === 1) {
        yield { type: 'text', text: 'Writing a long answer' };
        streamed += 1;
        // Text has arrived, which is the case the old rule refused to cut. The Steer comes now.
        push('Stop: use the other file', { interrupt: true });
        // This reply would stream for ten seconds if nothing aborted it, far longer than the test's patience.
        for (let index = 0; index < 10_000 && !signal?.aborted; index += 1) {
          await new Promise((resolve) => { setTimeout(resolve, 1); });
          yield { type: 'text', text: '.' };
          streamed += 1;
        }
        yield { type: 'done', message: { role: 'assistant', content: 'A long answer.' }, finishReason: 'stop', usage };
        return;
      }
      yield { type: 'done', message: { role: 'assistant', content: 'Used the other file.' }, finishReason: 'stop', usage };
    }
  };
  const run = new AgentRun({
    client, model: 'm', tools: [], context: { root, checkpoints: new RunCheckpoints('steer-cut'), readFiles: new Set() } as never,
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, input,
    requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined
  });
  const startedAt = Date.now();
  const result = await run.run([{ role: 'user', content: 'start' }], new AbortController().signal);
  const took = Date.now() - startedAt;
  assert.equal(result.outcome, 'completed', 'an interrupted turn is not a failure');
  assert.equal(seen.length, 2, 'the interrupted reply was followed by a second request');
  assert.ok(took < 2_000, `the reply was cut at once (took ${took} ms; uncut it would run for ten seconds)`);
  assert.ok(streamed < 1_000, `the stream stopped early (${streamed} pieces)`);
  assert.ok(seen[1]?.some((message) => message.role === 'user' && message.content === 'Stop: use the other file'), 'the Steer is the newest direction');
});

test('a message sent without Steer still waits for the reply to finish, as before', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-steer-wait-'));
  const { input, push } = interruptingQueue();
  const seen: AgentMessage[][] = [];
  let streamedToEnd = false;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], _tools: unknown, signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      if (seen.length === 1) {
        yield { type: 'text', text: 'Answering' };
        push('One more thing');
        for (let index = 0; index < 5; index += 1) { await new Promise((resolve) => { setTimeout(resolve, 1); }); yield { type: 'text', text: '.' }; }
        streamedToEnd = signal?.aborted !== true;
        yield { type: 'done', message: { role: 'assistant', content: 'Answering.' }, finishReason: 'stop', usage };
        return;
      }
      yield { type: 'done', message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop', usage };
    }
  };
  const run = new AgentRun({
    client, model: 'm', tools: [], context: { root, checkpoints: new RunCheckpoints('steer-wait'), readFiles: new Set() } as never,
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, input,
    requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined
  });
  const result = await run.run([{ role: 'user', content: 'start' }], new AbortController().signal);
  assert.equal(result.outcome, 'completed');
  assert.equal(streamedToEnd, true, 'a queued message does not cut the reply');
  assert.equal(seen.length, 2, 'and the agent picks it up before its next request');
});

test('sidebar: a Steer through the real message path is taken as an interruption, not a queue', async () => {
  // The 0.4.18 review found the button did nothing because the parser dropped `interrupt`, and the loop-level tests could not see it. This goes
  // through the sidebar's own parser, the host's steer handler and the conversation's flag, so a regression at any of those fails here.
  const { root, auth } = await projectWithProfile();
  const near = fakeNear((messages) => near.requests.length === 1 ? editCall : { content: `Saw: ${lastUser(messages)}` });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    const approval = await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    // A Steer, exactly as the page posts it.
    await sidebar.send({ type: 'steer', id: 'steer-cccccccccccc', text: 'Stop: use 9090 instead', interrupt: true });
    // The host says at once that it was taken as an interruption.
    // It is queued first and then says it is interrupting, which is the order the conversation produces.
    assert.deepEqual(steerStates(sidebar.posted, 'steer-cccccccccccc'), ['queued', 'interrupting'], JSON.stringify(steerStates(sidebar.posted, 'steer-cccccccccccc')));
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    const users = (near.requests[1] ?? []).filter((message) => message.role === 'user').map((message) => String(message.content));
    assert.ok(users.some((text) => text.includes('Stop: use 9090 instead')), 'the steer reached the model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- 0.4.18: two named choices on an approval card (owner, 2026-11-06) ---------------------------------------------------------------
// "Allow and Allow this command for this run seem to do the same thing. I'd rather see Allow this time, Allow Every Time (and if they select Allow
// Every Time, it actually learns to allow it every time)."
test('the approval card offers Allow this time and Allow every time, and "for this run" only where it differs', () => {
  const page = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const card = page.slice(page.indexOf('function onApproval('), page.indexOf('function onQuestions('));
  assert.match(card, /textButton\('Allow this time'/, 'the per-call choice says it is per call');
  assert.match(card, /textButton\('Allow every time', \(\) => answer\('allow-always'\)/, 'the permanent choice is named, and permanent');
  assert.doesNotMatch(card, /textButton\('Allow', /, 'the bare Allow that meant the same thing is gone');
  // "For this run" is offered only when no permanent entry can be made, so the two never read as duplicates.
  assert.match(card, /if \(m\.allowRule\) choices\.append\(textButton\('Allow every time'/, 'every time appears only when there is an entry to save');
  assert.match(card, /m\.allowRule === undefined/, 'for this run appears only when there is none');
});

test('sidebar: a plain message in a project with a team works with that team, says so once, and sends the note once', async () => {
  const { root, auth } = await projectWithProfile();
  const teamsDir = await mkdtemp(path.join(tmpdir(), 'near-ai-teams-dir-'));
  const previousTeams = process.env.NEAR_AI_TEAMS_DIR;
  process.env.NEAR_AI_TEAMS_DIR = teamsDir;
  const { mkdir: makeDir } = await import('node:fs/promises');
  const { renderTeam, TeamLibrary } = await import('../agent/teams');
  await makeDir(path.dirname(TeamLibrary.projectTeamFile(root)), { recursive: true });
  await writeFile(TeamLibrary.projectTeamFile(root), renderTeam('Project team', 'Builds it', [{ name: 'designer', role: 'designer', instructions: 'Make images.' }]));
  const near = fakeNear(() => ({ content: 'ok' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const asked: string[] = [];
    const window = vscodeStub.window as Record<string, unknown>;
    const previousAsk = window.showInformationMessage;
    window.showInformationMessage = async (text: string) => { asked.push(text); return 'Use this team'; };
    const sidebar = await openSidebar(root, auth);
    try {
      await sidebar.send({ type: 'send', text: 'make the pictures', model: 'z-ai/glm-5.3' });
      await sidebar.send({ type: 'send', text: 'and a banner', model: 'z-ai/glm-5.3' });
    } finally { window.showInformationMessage = previousAsk; }
    assert.equal(asked.length, 1, 'asked once for the project\'s team');
    assert.match(asked[0], /^This project has a team in \.planning\/\.near-ai\/team\.md: designer \(designer\)\. Use it/);
    const notices = sidebar.posted.filter((message) => message.type === 'notice' && /^Working with /.test(String(message.text)));
    assert.deepEqual(notices.map((message) => message.text), ['Working with this project\'s team "Project team" (from .planning/.near-ai/team.md): its members do the specialist work.'], 'said once');
    assert.match(lastUser(near.requests[0]), /^<team name="Project team">[\s\S]*- designer \(designer\): Make images\.[\s\S]*<\/team>\n\nmake the pictures$/, 'the chat passes the team to the run');
    assert.equal(lastUser(near.requests[1]), 'and a banner', 'the note is not repeated');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTeams === undefined) delete process.env.NEAR_AI_TEAMS_DIR; else process.env.NEAR_AI_TEAMS_DIR = previousTeams;
  }
});

test('sidebar: a project team the person declines is not used, and a closed question asks again next time', async () => {
  const { root, auth } = await projectWithProfile();
  const { mkdir: makeDir } = await import('node:fs/promises');
  const { renderTeam, TeamLibrary } = await import('../agent/teams');
  await makeDir(path.dirname(TeamLibrary.projectTeamFile(root)), { recursive: true });
  await writeFile(TeamLibrary.projectTeamFile(root), renderTeam('Declined team', 'Builds it', [{ name: 'designer', role: 'designer', instructions: 'Make images.' }]));
  const near = fakeNear(() => ({ content: 'ok' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  const window = vscodeStub.window as Record<string, unknown>;
  const previousAsk = window.showInformationMessage;
  const answers: Array<string | undefined> = [undefined, "Don't use it"];
  let asked = 0;
  window.showInformationMessage = async () => { asked += 1; return answers.shift(); };
  try {
    const sidebar = await openSidebar(root, auth);
    await sidebar.send({ type: 'send', text: 'one', model: 'z-ai/glm-5.3' });
    await sidebar.send({ type: 'send', text: 'two', model: 'z-ai/glm-5.3' });
    await sidebar.send({ type: 'send', text: 'three', model: 'z-ai/glm-5.3' });
    assert.equal(asked, 2, 'closed once (asked again), then declined (not asked a third time)');
    assert.deepEqual(near.requests.map(lastUser), ['one', 'two', 'three'], 'no team note in any of them');
  } finally {
    window.showInformationMessage = previousAsk;
    globalThis.fetch = originalFetch;
  }
});
