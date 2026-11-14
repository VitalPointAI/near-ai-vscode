import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
    // 0.4.21: a steer may carry attachment IDs, but only well-formed ones (the cases are in the attachment test below).
    { type: 'steer', id, text: 'hi', attachmentIds: ['att-XYZ'] }
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

// --- 0.4.21: a message's attachments go with that message, also when it is sent during a run, and the file is saved into the project when attached. ---

/** Attaches a file from outside the project through the real attach path, and returns its ID and what the chip was told. */
async function attach(sidebar: Awaited<ReturnType<typeof openSidebar>>, name: string, body: string) {
  const outside = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-src-'));
  const file = path.join(outside, name);
  await writeFile(file, body);
  (vscodeStub.window as Record<string, unknown>).showOpenDialog = async () => [{ fsPath: file }];
  const before = sidebar.posted.length;
  await sidebar.send({ type: 'attach-files' });
  const staged = sidebar.posted.slice(before).find((message) => message.type === 'attachment-staged');
  assert.ok(staged, 'the file is staged');
  return staged as { id: string; name: string; savedAs?: string };
}

test('the bridge accepts attachment IDs on a steer, strictly', () => {
  const id = 'steer-0123456789ab';
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id, text: 'see this', attachmentIds: ['att-0123456789ab'] }), { type: 'steer', id, text: 'see this', attachmentIds: ['att-0123456789ab'] });
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id, text: 'see this', attachmentIds: [] }), { type: 'steer', id, text: 'see this' });
  for (const attachmentIds of [['nope'], 'att-0123456789ab', Array.from({ length: 11 }, () => 'att-0123456789ab')]) {
    assert.equal(parseChatWebviewMessage({ type: 'steer', id, text: 'see this', attachmentIds }), undefined);
  }
});

test('sidebar: an attached file is saved into the project the moment it is attached, and the chip says where', async () => {
  const { root, auth } = await projectWithProfile();
  const sidebar = await openSidebar(root, auth);
  const staged = await attach(sidebar, 'notes.txt', 'the plan is in here');
  assert.equal(staged.savedAs, path.join('.near-ai', 'attachments', 'notes.txt'));
  assert.equal(readFileSync(path.join(root, staged.savedAs), 'utf8'), 'the plan is in here', 'the copy is in the workspace before anything is sent');
});

test('sidebar: a file attached to a message sent during a run reaches the running agent in that same message', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear((messages) => near.requests.length === 1 ? editCall : { content: `Saw: ${lastUser(messages)}` });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    const approval = await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    const staged = await attach(sidebar, 'ports.txt', 'staging uses port 9090');
    await sidebar.send({ type: 'steer', id: 'steer-a1a1a1a1a1a1', text: 'check the attached ports file', attachmentIds: [staged.id] });
    assert.deepEqual(sidebar.posted.find((message) => message.type === 'attachments-cleared')?.ids, [staged.id], 'its file leaves the composer, and only its file');
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    assert.equal(near.requests.length, 2, 'still one run');
    const delivered = lastUser(near.requests[1]);
    assert.match(delivered, /staging uses port 9090/, 'the file\'s content is in the message');
    assert.match(delivered, /\.near-ai[\\/]attachments[\\/]ports\.txt/, 'and where it is saved in the project');
    assert.match(delivered, /<user-message-during-run>\ncheck the attached ports file\n<\/user-message-during-run>/, 'with the words that refer to it');
    assert.deepEqual(steerStates(sidebar.posted, 'steer-a1a1a1a1a1a1'), ['queued', 'delivered']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: a message with a file sent as the run ends becomes the next turn with its file', async () => {
  const { root, auth } = await projectWithProfile();
  let releaseBilling!: () => void;
  let billingReached = false;
  const billingGate = new Promise<void>((resolve) => { releaseBilling = resolve; });
  const near = fakeNear((messages) => ({ content: `Saw: ${lastUser(messages)}` }), { billing: async () => { if (!billingReached) { billingReached = true; await billingGate; } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'hello', model: 'z-ai/glm-5.3' });
    await until(() => billingReached);
    const queued = await attach(sidebar, 'queued.txt', 'queued file body');
    await sidebar.send({ type: 'steer', id: 'steer-b2b2b2b2b2b2', text: 'read the queued file', attachmentIds: [queued.id] });
    releaseBilling();
    await running;
    assert.deepEqual(steerStates(sidebar.posted, 'steer-b2b2b2b2b2b2'), ['queued', 'sent-new']);
    assert.equal(near.requests.length, 2);
    assert.match(lastUser(near.requests[1]), /queued file body[\s\S]*read the queued file$/, 'the new turn carries the file, then the words');

    // With nothing running, a message with a file is an ordinary message with its file.
    const idle = await attach(sidebar, 'idle.txt', 'idle file body');
    await sidebar.send({ type: 'steer', id: 'steer-c3c3c3c3c3c3', text: 'and this one', attachmentIds: [idle.id] });
    assert.equal(near.requests.length, 3);
    assert.match(lastUser(near.requests[2]), /idle file body[\s\S]*and this one$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: Stop hands a queued message back with its attachments, ready to send again', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear(() => near.requests.length === 1 ? editCall : { content: 'should not happen' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    const staged = await attach(sidebar, 'later.txt', 'for later');
    await sidebar.send({ type: 'steer', id: 'steer-d4d4d4d4d4d4', text: 'look at this', attachmentIds: [staged.id] });
    const before = sidebar.posted.length;
    await sidebar.send({ type: 'stop' });
    await running;
    const after = sidebar.posted.slice(before);
    assert.ok(after.some((message) => message.type === 'steer-state' && message.state === 'returned' && message.text === 'look at this'));
    assert.ok(after.some((message) => message.type === 'attachment-staged' && message.id === staged.id && message.savedAs), 'the file is staged again');
    assert.equal(near.requests.length, 1, 'nothing more is sent after stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a message sent during a run no longer leaves its attachments staged for a later message', () => {
  const chat = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.equal(chat.includes('Attachments stay staged'), false);
  assert.match(chat, /type: 'steer', id, text[^\n]*attachmentIds: ids/);
});

test('sidebar: a message whose file trips the outbound check is not sent, and its file stays attached in the composer', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear(() => near.requests.length === 1 ? editCall : { content: 'done' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    const approval = await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    const staged = await attach(sidebar, 'creds.txt', 'api_key=sk-live-999');
    await sidebar.send({ type: 'steer', id: 'steer-e5e5e5e5e5e5', text: 'use these', attachmentIds: [staged.id] });
    const blocked = sidebar.posted.find((message) => message.type === 'steer-state' && message.id === 'steer-e5e5e5e5e5e5');
    assert.equal(blocked?.state, 'blocked');
    assert.match(String(blocked?.reason), /credential/);
    assert.equal(sidebar.posted.some((message) => message.type === 'attachments-cleared'), false, 'the file keeps its chip');
    assert.equal(existsSync(path.join(root, staged.savedAs!)), false, 'the blocked file\'s copy is not left in the project');
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    assert.equal(near.requests.some((messages) => JSON.stringify(messages).includes('sk-live-999')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: a queued file whose message is stopped comes back to the composer and never rides on a later message', async () => {
  const { root, auth } = await projectWithProfile();
  let releaseBilling!: () => void;
  let billingReached = false;
  const billingGate = new Promise<void>((resolve) => { releaseBilling = resolve; });
  const near = fakeNear((messages) => ({ content: `Saw: ${lastUser(messages)}` }), { billing: async () => { if (!billingReached) { billingReached = true; await billingGate; } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  const { setEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'hello', model: 'z-ai/glm-5.3' });
    await until(() => billingReached);
    const queued = await attach(sidebar, 'carried.txt', 'carried file body');
    await sidebar.send({ type: 'steer', id: 'steer-f6f6f6f6f6f6', text: 'read the carried file', attachmentIds: [queued.id] });
    const before = sidebar.posted.length;
    await setEmergencyStop(true);
    await until(() => sidebar.posted.slice(before).some((message) => message.type === 'attachment-staged' && message.id === queued.id));
    releaseBilling();
    await running;
    await setEmergencyStop(false);
    assert.equal(near.requests.length, 1, 'the queued message was not sent');
    await sidebar.send({ type: 'send', text: 'something else', model: 'z-ai/glm-5.3' });
    assert.equal(near.requests.length, 2);
    assert.equal(JSON.stringify(near.requests[1]).includes('carried file body'), false, 'the file does not ride on an unrelated message');
  } finally {
    await setEmergencyStop(false);
    globalThis.fetch = originalFetch;
  }
});

test('sidebar: a file taken out before sending leaves no copy, and a steer whose file is gone is not sent without it', async () => {
  const { root, auth } = await projectWithProfile();
  const near = fakeNear(() => near.requests.length === 1 ? editCall : { content: 'done' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = near.fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const removed = await attach(sidebar, 'draft.txt', 'not wanted');
    assert.equal(existsSync(path.join(root, removed.savedAs!)), true);
    await sidebar.send({ type: 'attachment-remove', id: removed.id });
    assert.equal(existsSync(path.join(root, removed.savedAs!)), false, 'removing the chip removes its copy');

    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    const approval = await until(() => sidebar.posted.find((message) => message.type === 'approval-request'));
    await sidebar.send({ type: 'steer', id: 'steer-a7a7a7a7a7a7', text: 'see the draft', attachmentIds: [removed.id] });
    const blocked = sidebar.posted.find((message) => message.type === 'steer-state' && message.id === 'steer-a7a7a7a7a7a7');
    assert.equal(blocked?.state, 'blocked');
    assert.match(String(blocked?.reason), /no longer available/);
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    assert.equal(near.requests.some((messages) => JSON.stringify(messages).includes('see the draft')), false, 'the words are not sent without their file');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
