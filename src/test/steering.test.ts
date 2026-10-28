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
  const listeners = new Set<() => void>();
  const input: RunInput = {
    pending: () => items.length > 0,
    take: () => items.splice(0).map((text) => ({ role: 'user' as const, content: text })),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  return { input, push: (text: string) => { items.push(text); for (const listener of [...listeners]) listener(); } };
}

const userTexts = (messages: AgentMessage[]) => messages.filter((message) => message.role === 'user').map((message) => String(message.content));

test('the bridge parses steer strictly', () => {
  const id = 'steer-0123456789ab';
  assert.deepEqual(parseChatWebviewMessage({ type: 'steer', id, text: '  use port 8080 ' }), { type: 'steer', id, text: 'use port 8080' });
  assert.ok(parseChatWebviewMessage({ type: 'steer', id, text: 'x'.repeat(MAX_MESSAGE_CHARS) }));
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
  assert.match(view, /<button id="stop" class="icon-button" type="button" aria-label="Stop" title="Stop the run \(Esc in an empty message box\)" hidden><\/button>\s*<button id="send"/);
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.doesNotMatch(script, /if \(busy\) \{ post\(\{ type: 'stop' \}\)/, 'Enter no longer stops the run');
  assert.match(script, /function updateSendState\(\) \{ send\.disabled = !input\.value\.trim\(\); \}/, 'Send depends only on there being text');
  assert.match(script, /event\.key === 'Escape' && busy && !input\.value\.trim\(\)/);
  assert.match(script, /if \(busy && !command\) \{ sendSteer\(text\); return; \}/);
  assert.match(script, /Finish or stop the current run first/);
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(css, /\.composer \.bar \.icon-button \{ flex: none; \}/, 'both buttons keep their size at narrow widths');
});
