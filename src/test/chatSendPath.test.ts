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

function fakeNear(calls: string[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url.replace('https://cloud-api.near.ai/v1', ''));
    if (url.endsWith('/models/pricing')) return new Response('{}', { status: 404 });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1.8, output: 5.75 } }, { id: 'deepseek/deepseek-v4.1-flash', pricing: { input: 0.3, output: 1.2 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }, { modelId: 'deepseek/deepseek-v4.1-flash', metadata: { attestationSupported: false, providerType: 'external', providerConfig: { base_url: 'https://openrouter.ai/api/v1' } } }] });
    if (url.endsWith('/billing/costs')) return Response.json({ requests: [{ requestId: INFERENCE_ID, costNanoUsd: 2_500_000 }] });
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
    const done = sidebar.posted.find((message) => message.type === "assistant-done") as { usage: { estimatedCostUsd: number; requestId: string } };
    assert.equal(done.usage.requestId, INFERENCE_ID);
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
