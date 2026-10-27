import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { deriveProfileId } from '../domain/auth';

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
const vscodeStub = {
  workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }>, name: 'demo', getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
  window: { showInformationMessage: () => undefined, showWarningMessage: () => undefined, activeTextEditor: undefined },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

async function openSidebar(root: string, auth: AuthService) {
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try {
    const { attachChatToView } = require('../services/chat') as typeof import('../services/chat');
    const view = {
      webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: () => ({ dispose() {} })
    };
    await attachChatToView({ subscriptions: [], globalStorageUri: { fsPath: path.join(root, '.global') }, extensionUri: { fsPath: root } } as never, auth, view as never, '<html></html>');
  } finally {
    nodeModule._load = originalLoad;
  }
  return { posted, send: (message: unknown) => receive!(message) };
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
  }
});
