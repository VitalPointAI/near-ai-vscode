import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile as writeFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { deriveProfileId } from '../domain/auth';
import { FOREIGN_LIVE_MS, RunMarkers } from '../services/runMarkers';
import { stateHomeFor } from '../services/stateHome';

// Drives the sidebar's real host path: attachChatToView -> initializeChat -> send handler ->
// OutboundGuard -> activeProvider -> NearAiClient, against a fake NEAR AI server. Only the VS
// Code host API and the network are stubbed.

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const INFERENCE_ID = '0b6e3f9e-5a1d-5c2b-8f4e-1d2c3b4a5f60';
const billingBodies: unknown[] = [];

function fakeNear(calls: string[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url.replace('https://cloud-api.near.ai/v1', ''));
    if (url.endsWith('/models/pricing')) return new Response('{}', { status: 404 });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1.8, output: 5.75 } }, { id: 'deepseek/deepseek-v4.1-flash', pricing: { input: 0.3, output: 1.2 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }, { modelId: 'deepseek/deepseek-v4.1-flash', metadata: { attestationSupported: false, providerType: 'external', providerConfig: { base_url: 'https://openrouter.ai/api/v1' } } }] });
    if (url.endsWith('/billing/costs')) {
      billingBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ requests: [{ requestId: INFERENCE_ID, costNanoUsd: 2_500_000 }] });
    }
    if (url.endsWith('/chat/completions')) {
      assert.equal(JSON.parse(String(init?.body)).stream_options.include_usage, true);
      const body = ['data: {"choices":[{"delta":{"content":"Hello"}}]}', 'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":1000}}', 'data: [DONE]', ''].join('\n\n');
      return new Response(body, { status: 200, headers: { 'inference-id': INFERENCE_ID } });
    }
    return new Response('not found', { status: 404 });
  };
}

// One stub object for the whole file: chat.ts is cached after the first require, so each test
// points the shared workspace at its own project instead of building a new stub.
/** Settings a test sets for one run; every other setting answers its default. */
const settingOverrides = new Map<string, unknown>();
const vscodeStub = {
  workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }>, name: 'demo', getConfiguration: () => ({ get: (key: string, fallback?: unknown) => (settingOverrides.has(key) ? settingOverrides.get(key) : fallback), inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showInformationMessage: () => undefined, showWarningMessage: () => undefined, activeTextEditor: undefined },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

class Memento {
  private readonly values = new Map<string, unknown>();
  public get<T>(key: string, fallback?: T): T | undefined { return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); return Promise.resolve(); }
}

/** What two sidebars of one editor share, and the context's subscriptions, so a test can dispose them. */
interface SidebarExtras { secrets?: SecretStorageLike; workspaceState?: Memento; subscriptions?: Array<{ dispose(): unknown }> }

async function openSidebar(root: string, auth: AuthService, extras: SidebarExtras = {}) {
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const view = {
    badge: undefined as { value: number; tooltip: string } | undefined,
    webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} })
  };
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try {
    const { attachChatToView } = require('../services/chat') as typeof import('../services/chat');
    await attachChatToView({ subscriptions: extras.subscriptions ?? [], globalStorageUri: { fsPath: path.join(root, '.global') }, extensionUri: { fsPath: root }, ...(extras.secrets ? { secrets: extras.secrets } : {}), ...(extras.workspaceState ? { workspaceState: extras.workspaceState } : {}) } as never, auth, view as never, '<html></html>');
  } finally {
    nodeModule._load = originalLoad;
  }
  return { posted, view, send: (message: unknown) => receive!(message) };
}

async function projectWithProfile() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-send-'));
  const auth = new AuthService(new MemorySecrets());
  const profiles = new ProfileStore(root, auth, { validator: async () => undefined });
  await profiles.configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  return { root, auth };
}

test('a sidebar message streams from NEAR with privacy label, estimate, and actual cost from billing', async () => {
  const { root, auth } = await projectWithProfile();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeNear(calls) as typeof fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const models = sidebar.posted.find((message) => message.type === 'models') as { models: Array<{ id: string; privacy: string }> };
    assert.deepEqual(models.models.map((model) => [model.id, model.privacy]), [['z-ai/glm-5.3', 'tee'], ['deepseek/deepseek-v4.1-flash', 'forwarded']]);
    await sidebar.send({ type: 'send', text: 'Say hello', model: 'z-ai/glm-5.3' });
    const start = sidebar.posted.find((message) => message.type === 'assistant-start');
    assert.equal(start?.privacy, 'Private · runs in NEAR TEE');
    const done = sidebar.posted.find((message) => message.type === 'assistant-done') as { usage: { estimatedCostUsd: number } };
    assert.deepEqual(billingBodies.at(-1), { requestIds: [INFERENCE_ID] }, 'the run is billed by each turn\'s inference-id');
    assert.equal(Number(done.usage.estimatedCostUsd.toFixed(5)), 0.00755);
    assert.deepEqual(sidebar.posted.find((message) => message.type === 'assistant-cost'), { type: 'assistant-cost', actualCostUsd: 0.0025 });
    assert.ok(calls.includes('/billing/costs'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a message containing a credential never reaches the model, and "send once anyway" does', async () => {
  const { root, auth } = await projectWithProfile();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeNear(calls) as typeof fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    await sidebar.send({ type: 'send', text: 'debug this: api_key=sk-live-999', model: 'z-ai/glm-5.3' });
    const blocked = sidebar.posted.find((message) => message.type === 'outbound-blocked') as { reason: string; overrideToken: string };
    assert.match(blocked.reason, /credential/);
    assert.equal(calls.includes('/chat/completions'), false);
    await sidebar.send({ type: 'send', text: 'debug this: api_key=sk-live-999', model: 'z-ai/glm-5.3', overrideToken: blocked.overrideToken });
    assert.equal(calls.filter((call) => call === '/chat/completions').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('without a profile the sidebar asks for setup and writes nothing to the project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-send-empty-'));
  const sidebar = await openSidebar(root, new AuthService(new MemorySecrets()));
  await sidebar.send({ type: 'send', text: 'hello', model: 'z-ai/glm-5.3' });
  assert.ok(sidebar.posted.some((message) => message.type === 'auth-required'));
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(root), []);
});

test('an agent run through the sidebar reads, asks to edit with a diff, edits on approval, and reverts', async () => {
  const { root, auth } = await projectWithProfile();
  const { writeFile, readFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'app.ts'), 'export const port = 3000;\n');
  const turns = [
    { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"app.ts"}' } }] },
    { tool_calls: [{ index: 0, id: 'call_edit', function: { name: 'Edit', arguments: '{"file_path":"app.ts","old_string":"3000","new_string":"8080"}' } }] },
    { content: 'Changed the port to 8080.' }
  ];
  let turn = 0;
  const calls: string[] = [];
  const base = fakeNear(calls);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith('/chat/completions')) return base(input, init);
    calls.push('/chat/completions');
    const delta = turns[turn++] ?? { content: 'done' };
    const body = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}', 'data: [DONE]', ''].join('\n\n');
    return new Response(body, { status: 200, headers: { 'inference-id': INFERENCE_ID } });
  }) as typeof fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    let approval: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 200 && !approval; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      approval = sidebar.posted.find((message) => message.type === 'approval-request');
    }
    assert.ok(approval, 'the edit waits for approval');
    assert.match(String((approval.preview as { diff: string }).diff), /-export const port = 3000;\n\+export const port = 8080;/);
    assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'export const port = 3000;\n', 'nothing changes before approval');
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'allow' });
    await running;
    assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'export const port = 8080;\n');
    assert.deepEqual(sidebar.posted.filter((message) => message.type === 'tool-start').map((message) => message.title), ['Read app.ts', 'Edit app.ts']);
    const changes = sidebar.posted.find((message) => message.type === 'run-changes') as { runId: string; files: string[] };
    assert.deepEqual(changes.files, ['app.ts']);
    await sidebar.send({ type: 'revert-run', runId: changes.runId });
    assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'export const port = 3000;\n');
    assert.deepEqual((sidebar.posted.find((message) => message.type === 'run-reverted') as { files: string[] }).files, ['app.ts']);
    assert.equal(calls.filter((call) => call === '/chat/completions').length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a waiting approval badges the view, is re-sent to a reloaded view, and clears once answered', async () => {
  const { root, auth } = await projectWithProfile();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'app.ts'), 'export const port = 3000;\n');
  const turns = [
    { tool_calls: [{ index: 0, id: 'call_write', function: { name: 'Write', arguments: '{"file_path":"notes.md","content":"x"}' } }] },
    { content: 'Wrote the notes.' }
  ];
  let turn = 0;
  const base = fakeNear([]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith('/chat/completions')) return base(input, init);
    const delta = turns[turn++] ?? { content: 'done' };
    const body = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}', 'data: [DONE]', ''].join('\n\n');
    return new Response(body, { status: 200, headers: { 'inference-id': INFERENCE_ID } });
  }) as typeof fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    await sidebar.send({ type: 'chat-ready' });
    assert.equal(sidebar.posted.some((message) => message.type === 'approval-request'), false, 'nothing to replay before a run');
    assert.equal(sidebar.view.badge, undefined);
    const running = sidebar.send({ type: 'send', text: 'Write notes', model: 'z-ai/glm-5.3' });
    let approval: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 200 && !approval; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      approval = sidebar.posted.find((message) => message.type === 'approval-request');
    }
    assert.ok(approval, 'the write waits for approval');
    assert.deepEqual(sidebar.view.badge, { value: 1, tooltip: 'NEAR AI is waiting for you' });
    await sidebar.send({ type: 'chat-ready' });
    const replays = sidebar.posted.filter((message) => message.type === 'approval-request');
    assert.equal(replays.length, 2);
    assert.deepEqual(replays[1], { ...approval, replay: true }, 'the reloaded view pins the same prompt again');
    await sidebar.send({ type: 'approval-reply', callId: approval.callId, decision: 'deny' });
    await running;
    assert.equal(sidebar.view.badge, undefined, 'the badge clears once nothing waits');
    await sidebar.send({ type: 'chat-ready' });
    assert.equal(sidebar.posted.filter((message) => message.type === 'approval-request').length, 2, 'an answered prompt is not replayed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a local runtime profile needs no key, labels its models local, and never calls NEAR billing or catalog', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-local-'));
  const auth = new AuthService(new MemorySecrets());
  const seen: Array<{ url: string; auth: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen3-coder:30b' }] });
    if (url.endsWith('/chat/completions')) return new Response(['data: {"choices":[{"delta":{"content":"local hello"}}]}', 'data: [DONE]', ''].join('\n\n'));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  try {
    const profiles = new ProfileStore(root, auth);
    const profile = await profiles.configure({ profileId: deriveProfileId(root, 'Demo local'), displayName: 'Demo (local)', organization: 'Demo', baseUrl: 'http://localhost:11434/v1', authMode: 'apiKey', provider: 'local' }, '');
    assert.equal(profile.validation.status, 'valid');
    const sidebar = await openSidebar(root, auth);
    const models = sidebar.posted.find((message) => message.type === 'models') as { models: Array<{ id: string; privacy: string; label: string }> };
    assert.deepEqual(models.models.map((model) => [model.id, model.privacy]), [['qwen3-coder:30b', 'local']]);
    await sidebar.send({ type: 'send', text: 'hi', model: 'qwen3-coder:30b' });
    assert.equal(sidebar.posted.find((message) => message.type === 'assistant-start')?.privacy, 'Local · runs on this machine');
    assert.ok(sidebar.posted.some((message) => message.type === 'assistant-done'));
    assert.equal(seen.some((request) => /model\/list|billing/.test(request.url)), false, 'no NEAR-only endpoints');
    assert.equal(seen.every((request) => request.url.startsWith('http://localhost:11434/v1/') && request.auth === null), true, 'only the local runtime, with no bearer header');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a hybrid profile lists cloud and local models and sends each message to the endpoint that serves its model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-hybrid-'));
  const auth = new AuthService(new MemorySecrets());
  const seen: Array<{ url: string; auth: string | null }> = [];
  const cloud = fakeNear([]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.startsWith('http://localhost:11434/v1/')) {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen3-coder:30b' }] });
      return new Response(['data: {"choices":[{"delta":{"content":"from local"}}]}', 'data: [DONE]', ''].join('\n\n'));
    }
    return cloud(input, init);
  }) as typeof fetch;
  try {
    const profiles = new ProfileStore(root, auth);
    const profile = await profiles.configure({ profileId: deriveProfileId(root, 'Demo hybrid'), displayName: 'Demo (cloud + local)', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', localBaseUrl: 'http://localhost:11434/v1', authMode: 'apiKey', provider: 'hybrid' }, 'sk-cloud', 'sk-local');
    assert.equal(profile.validation.status, 'valid');
    const sidebar = await openSidebar(root, auth);
    const models = sidebar.posted.find((message) => message.type === 'models') as { models: Array<{ id: string; privacy: string }> };
    assert.deepEqual(models.models.map((model) => [model.id, model.privacy]).sort(), [['deepseek/deepseek-v4.1-flash', 'forwarded'], ['qwen3-coder:30b', 'local'], ['z-ai/glm-5.3', 'tee']]);
    seen.length = 0;
    await sidebar.send({ type: 'send', text: 'hi local', model: 'qwen3-coder:30b' });
    assert.deepEqual(seen.map((request) => [new URL(request.url).host, request.auth]), [['localhost:11434', 'Bearer sk-local']]);
    seen.length = 0;
    await sidebar.send({ type: 'send', text: 'hi cloud', model: 'z-ai/glm-5.3' });
    assert.equal(seen.every((request) => new URL(request.url).host === 'cloud-api.near.ai' && request.auth === 'Bearer sk-cloud'), true);
    assert.ok(seen.some((request) => request.url.endsWith('/billing/costs')), 'cloud turns are billed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a GSD slash command runs the installed skill on the runner: it asks a question, spawns a sub-agent, and reports', async () => {
  const { root, auth } = await projectWithProfile();
  const { writeFile: write, mkdir: makeDir } = await import('node:fs/promises');
  // The command list must not pick up the real teams library in the person's home folder, so point it at an empty folder inside the project.
  const previousTeamsDir = process.env.NEAR_AI_TEAMS_DIR;
  process.env.NEAR_AI_TEAMS_DIR = path.join(root, '.teams-home');
  // An installed runtime in the extension's storage, laid out as the installer leaves it.
  const home = path.join(root, '.global', 'gsd', '1.20.0');
  await makeDir(path.join(home, 'gsd-core', 'bin'), { recursive: true });
  await makeDir(path.join(home, 'skills', 'gsd-progress'), { recursive: true });
  await makeDir(path.join(home, 'agents'), { recursive: true });
  await write(path.join(home, 'gsd-core', 'VERSION'), '1.20.0\n');
  await write(path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs'), '');
  await write(path.join(home, 'gsd-core', 'progress-workflow.md'), 'WORKFLOW: report the current phase.');
  await write(path.join(home, 'skills', 'gsd-progress', 'SKILL.md'), `---\nname: gsd-progress\ndescription: Show progress\nargument-hint: "[--verbose]"\n---\n<arguments>$ARGUMENTS</arguments>\n@${path.join(home, 'gsd-core', 'progress-workflow.md')}\n`);
  await write(path.join(home, 'agents', 'gsd-planner.md'), '---\nname: gsd-planner\ndescription: Plans\ntools: Read, Grep\nmodel: haiku\n---\nYou are the GSD planner.\n');
  await write(path.join(root, '.global', 'gsd', 'current.json'), JSON.stringify({ version: '1.20.0' }));
  await write(path.join(root, 'ROADMAP.md'), '# Phase 9\n');
  const parent = [
    { tool_calls: [{ index: 0, id: 'ask1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ question: 'Which phase?', header: 'Phase', options: [{ label: 'Phase 9' }, { label: 'Phase 10' }], multiSelect: false }] }) } }] },
    { tool_calls: [{ index: 0, id: 'agent1', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'gsd-planner', description: 'Read the roadmap', prompt: 'Read ROADMAP.md and summarise it.', model: 'haiku' }) } }] },
    { content: 'Progress for Phase 9 is ready.' }
  ];
  const child = [
    { tool_calls: [{ index: 0, id: 'r1', function: { name: 'Read', arguments: '{"file_path":"ROADMAP.md"}' } }] },
    { content: 'The roadmap lists Phase 9.' }
  ];
  const requests: Array<{ model: string; system: string; user: string; tools: string[] }> = [];
  const calls: string[] = [];
  const base = fakeNear(calls);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith('/chat/completions')) return base(input, init);
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
    requests.push({ model: body.model, system: body.messages[0].content, user: body.messages[1]?.content ?? '', tools: (body.tools ?? []).map((tool) => tool.function.name) });
    const isChild = body.messages[0].content.startsWith('You are the GSD planner.');
    const script = isChild ? child : parent;
    const turn = body.messages.filter((message) => message.role === 'assistant').length;
    const delta = script[turn] ?? { content: 'done' };
    const stream = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5}}', 'data: [DONE]', ''].join('\n\n');
    return new Response(stream, { headers: { 'inference-id': INFERENCE_ID } });
  }) as typeof fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    const running = sidebar.send({ type: 'open-command', command: 'progress', args: '--verbose', model: 'z-ai/glm-5.3' });
    let questions: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 300 && !questions; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      questions = sidebar.posted.find((message) => message.type === 'questions-request');
    }
    assert.ok(questions, 'the workflow waits for the answer');
    await sidebar.send({ type: 'questions-reply', id: questions.id, answers: ['Phase 9'] });
    await running;
    const first = requests[0];
    assert.match(first.user, /The user ran \/gsd-progress --verbose/);
    assert.match(first.user, /<arguments>--verbose<\/arguments>/);
    assert.match(first.user, /WORKFLOW: report the current phase\./, 'the @ include was expanded');
    assert.ok(['Skill', 'AskUserQuestion', 'Agent', 'Task', 'WebFetch'].every((tool) => first.tools.includes(tool)));
    const childRequest = requests.find((request) => request.system.startsWith('You are the GSD planner.'))!;
    assert.equal(childRequest.model, 'z-ai/glm-5.3', 'the fast tier falls back to the chosen model when the provider lacks it');
    assert.deepEqual(childRequest.tools.sort(), ['Grep', 'Read'], 'a sub-agent gets only the tools its definition lists');
    const agentResult = requests.filter((request) => !request.system.startsWith('You are the GSD planner.')).length;
    assert.equal(agentResult, 3);
    assert.ok(sidebar.posted.some((message) => message.type === 'tool-start' && String(message.title).startsWith('gsd-planner › Read ROADMAP.md')));
    assert.ok(sidebar.posted.some((message) => message.type === 'assistant-done'));
    const commandList = sidebar.posted.filter((message) => message.type === 'commands').at(-1) as { commands: Array<{ command: string; argumentHint?: string }> };
    assert.deepEqual(commandList.commands, [{ command: 'gsd-progress', title: 'gsd-progress', description: 'Show progress', argumentHint: '[--verbose]' }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTeamsDir === undefined) delete process.env.NEAR_AI_TEAMS_DIR; else process.env.NEAR_AI_TEAMS_DIR = previousTeamsDir;
  }
});


// Phase 27, plan 34: a conversation that another editor is running right now is not run from here too.

const OTHER_EDITOR = 'edaaaaaa.inst0001';
const OTHER_RUN = 'run-1793570629237-876b3a';
const HOLD = 'This conversation is running in another editor right now. Wait for it to finish there, or start a new conversation here.';
const MINUTE = 60_000;

/** A conversation saved by one sidebar (its first run ended), and what another sidebar of the same editor needs to reopen it. */
async function savedConversation(script?: (turn: number) => Record<string, unknown>) {
  const { root, auth } = await projectWithProfile();
  const shared = { secrets: new MemorySecrets(), workspaceState: new Memento(), subscriptions: [] as Array<{ dispose(): unknown }> };
  const calls: string[] = [];
  const base = fakeNear(calls);
  let turn = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!script || !String(input).endsWith('/chat/completions')) return base(input, init);
    calls.push('/chat/completions');
    const delta = script(turn++);
    const body = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}', 'data: [DONE]', ''].join('\n\n');
    return new Response(body, { status: 200, headers: { 'inference-id': INFERENCE_ID } });
  }) as typeof fetch;
  const first = await openSidebar(root, auth, shared);
  await first.send({ type: 'send', text: 'first question', model: 'z-ai/glm-5.3' });
  const id = (first.posted.filter((message) => message.type === 'conversations').at(-1) as { activeId: string }).activeId;
  const runs = stateHomeFor(root).paths.runs;
  const file = path.join(runs, `${id}.json`);
  // Its own run marker is written in the background; wait until it has ended before another editor takes over.
  for (let attempt = 0; attempt < 300 && !JSON.parse(await readFile(file, 'utf8').catch(() => '{}')).endedAt; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const others: RunMarkers[] = [];
  /** Another editor starts a run of the conversation, its last sign of life `ageMs` ago. */
  const otherEditorRuns = async (runId = OTHER_RUN, ageMs = 0): Promise<RunMarkers> => {
    const other = new RunMarkers('', root, { dir: runs, writer: OTHER_EDITOR, pid: 4242, alive: () => true, now: () => Date.now() - ageMs });
    others.push(other);
    await other.start({ conversationId: id, runId });
    await other.idle();
    return other;
  };
  /** A second sidebar of this editor (a reload, or another window): it reopens the saved conversation. */
  const reopen = async () => {
    const second = await openSidebar(root, auth, shared);
    await second.send({ type: 'chat-ready' });
    return second;
  };
  const cleanup = () => { for (const other of others) other.dispose(); mock.restoreAll(); settingOverrides.clear(); require('../services/chat').setFollowElsewhereMs(undefined); };
  return { root, id, file, calls, first, shared, otherEditorRuns, reopen, cleanup };
}

async function snapshot(root: string, id: string): Promise<{ threads: Record<string, string>; marker: string }> {
  const dir = stateHomeFor(root).paths.threads;
  const threads: Record<string, string> = {};
  for (const name of await readdir(dir).catch(() => [] as string[])) threads[name] = await readFile(path.join(dir, name), 'utf8').catch(() => '');
  return { threads, marker: await readFile(path.join(stateHomeFor(root).paths.runs, `${id}.json`), 'utf8') };
}

const elsewhereNotice = (message: Record<string, unknown>) => message.type === 'notice' && /running in another editor right now\. Its newest steps/.test(String(message.text));
const chatRequests = (calls: string[]) => calls.filter((call) => call === '/chat/completions').length;

test('tracer: a message to a conversation running in another editor is held, with nothing requested or written', async () => {
  const originalFetch = globalThis.fetch;
  const saved = await savedConversation();
  try {
    await saved.otherEditorRuns();
    const second = await saved.reopen();
    assert.ok(second.posted.some(elsewhereNotice), 'the reopened conversation says it is running elsewhere');
    const before = await snapshot(saved.root, saved.id);
    const requests = chatRequests(saved.calls);
    second.posted.length = 0;
    await second.send({ type: 'send', text: 'hello', model: 'z-ai/glm-5.3', conversationId: saved.id });
    assert.equal(chatRequests(saved.calls), requests, 'no model request');
    assert.deepEqual(second.posted.filter((message) => message.type === 'notice').map((message) => message.text), [HOLD]);
    assert.deepEqual(await snapshot(saved.root, saved.id), before, 'the thread and the run marker are as they were, byte for byte');
  } finally {
    saved.cleanup();
    globalThis.fetch = originalFetch;
  }
});

test('Resume and Dismiss on a cut-off run that another editor has since taken over are held, and touch nothing', async () => {
  const originalFetch = globalThis.fetch;
  const saved = await savedConversation();
  try {
    await saved.otherEditorRuns('run-1793570629237-111111', 10 * MINUTE);
    const second = await saved.reopen();
    assert.ok(second.posted.some((message) => message.type === 'run-interrupted'), 'quiet for 10 minutes: shown as cut off, with Resume');
    // The other editor resumes it meanwhile: its marker is live again.
    await saved.otherEditorRuns();
    const before = await snapshot(saved.root, saved.id);
    const requests = chatRequests(saved.calls);
    second.posted.length = 0;
    await second.send({ type: 'resume-interrupted', conversationId: saved.id });
    await second.send({ type: 'dismiss-interrupted', conversationId: saved.id });
    assert.equal(chatRequests(saved.calls), requests, 'no model request');
    assert.deepEqual(second.posted.filter((message) => message.type === 'notice').map((message) => message.text), [HOLD, HOLD]);
    assert.deepEqual(await snapshot(saved.root, saved.id), before, 'the other editor\'s marker is not ended');
  } finally {
    saved.cleanup();
    globalThis.fetch = originalFetch;
  }
});

test('Continue on a stopped run is held while another editor runs the conversation', async () => {
  const originalFetch = globalThis.fetch;
  settingOverrides.set('agent.maxTurns', 5);
  const saved = await savedConversation(() => ({ tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"missing.txt"}' } }] }));
  try {
    const stopped = saved.first.posted.find((message) => message.type === 'run-stopped');
    assert.equal(stopped?.continuable, true, 'the run stopped short and offers Continue');
    await saved.otherEditorRuns();
    const before = await snapshot(saved.root, saved.id);
    const requests = chatRequests(saved.calls);
    saved.first.posted.length = 0;
    await saved.first.send({ type: 'continue-run', conversationId: saved.id });
    assert.equal(chatRequests(saved.calls), requests, 'no model request');
    assert.deepEqual(saved.first.posted.filter((message) => message.type === 'notice').map((message) => message.text), [HOLD]);
    assert.deepEqual(await snapshot(saved.root, saved.id), before);
  } finally {
    saved.cleanup();
    globalThis.fetch = originalFetch;
  }
});

test('the view follows the other editor run and reloads the conversation once that run has ended', async () => {
  const originalFetch = globalThis.fetch;
  const saved = await savedConversation();
  try {
    const other = await saved.otherEditorRuns();
    (require('../services/chat') as typeof import('../services/chat')).setFollowElsewhereMs(20);
    const second = await saved.reopen();
    const transcripts = () => second.posted.filter((message) => message.type === 'transcript').length;
    assert.ok(second.posted.some(elsewhereNotice));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = transcripts();
    await other.end(saved.id, OTHER_RUN, 'completed');
    await other.idle();
    for (let attempt = 0; attempt < 200 && transcripts() === before; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(transcripts() > before, 'a transcript message is posted again');
    const last = second.posted.map((message) => message.type).lastIndexOf('conversation-show');
    assert.equal(second.posted.slice(last).some(elsewhereNotice), false, 'the running-elsewhere notice is gone');
    assert.equal(second.posted.slice(last).some((message) => message.type === 'run-interrupted'), false, 'a run that finished is not shown as cut off');
  } finally {
    saved.cleanup();
    globalThis.fetch = originalFetch;
  }
});

test('the view follows the other editor run, and one that goes quiet is shown as cut off with Resume', async () => {
  const originalFetch = globalThis.fetch;
  const saved = await savedConversation();
  try {
    await saved.otherEditorRuns();
    (require('../services/chat') as typeof import('../services/chat')).setFollowElsewhereMs(20);
    const second = await saved.reopen();
    const marker = JSON.parse(await readFile(saved.file, 'utf8')) as Record<string, unknown>;
    marker.activeAt = new Date(Date.now() - FOREIGN_LIVE_MS - MINUTE).toISOString();
    await writeFileAsync(saved.file, `${JSON.stringify(marker)}\n`);
    second.posted.length = 0;
    for (let attempt = 0; attempt < 200 && !second.posted.some((message) => message.type === 'run-interrupted'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const cut = second.posted.find((message) => message.type === 'run-interrupted');
    assert.ok(cut, 'the reloaded conversation shows the run-interrupted message');
    assert.equal(cut.resumable, true);
  } finally {
    saved.cleanup();
    globalThis.fetch = originalFetch;
  }
});

test('a conversation nobody is running still sends, and disposing the extension stops the heartbeats and the follow timer', async () => {
  const originalFetch = globalThis.fetch;
  const saved = await savedConversation();
  try {
    assert.equal(chatRequests(saved.calls), 1, 'a new conversation sends as before');
    await saved.otherEditorRuns();
    (require('../services/chat') as typeof import('../services/chat')).setFollowElsewhereMs(20);
    await saved.reopen();
    const disposeSpy = mock.method(RunMarkers.prototype, 'dispose');
    const checks = mock.method(RunMarkers.prototype, 'liveElsewhere');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(checks.mock.callCount() > 0, 'the follow check is running');
    for (const subscription of saved.shared.subscriptions) subscription.dispose();
    assert.ok(disposeSpy.mock.callCount() >= 1, 'the project\'s run-marker store was disposed with the extension');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = checks.mock.callCount();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(checks.mock.callCount(), after, 'no follow check runs after the extension is disposed');
  } finally {
    saved.cleanup();
    globalThis.fetch = originalFetch;
  }
});
