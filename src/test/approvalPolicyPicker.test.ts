import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { deriveProfileId } from '../domain/auth';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { applyPolicyChoice, POLICY_MODES, POLICY_OPTIONS, PolicyConfiguration, policyStateMessage } from '../services/approvalPolicy';

// The composer's approval-policy picker: strict parsing, the scope it writes, the Full auto
// confirmation, live updates from settings and the emergency stop, and that the next run uses it.

const TARGETS = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
type Scope = 'globalValue' | 'workspaceValue' | 'workspaceFolderValue';
const SCOPE_BY_TARGET: Record<number, Scope> = { 1: 'globalValue', 2: 'workspaceValue', 3: 'workspaceFolderValue' };

/** A nearAi configuration section with real scope precedence and change events. */
class FakeConfiguration implements PolicyConfiguration {
  public values: Partial<Record<Scope, unknown>> = {};
  public writes: Array<{ key: string; value: unknown; target: number }> = [];
  public listeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
  public get<T>(key: string, fallback: T): T {
    if (key !== 'actionPolicy') return fallback;
    return (this.values.workspaceFolderValue ?? this.values.workspaceValue ?? this.values.globalValue ?? fallback) as T;
  }
  public inspect(key: string) { return key === 'actionPolicy' ? { ...this.values } : undefined; }
  public async update(key: string, value: unknown, target: number): Promise<void> {
    this.writes.push({ key, value, target });
    this.values[SCOPE_BY_TARGET[target]] = value;
    this.fire(`nearAi.${key}`);
  }
  public fire(section: string): void {
    for (const listener of this.listeners) listener({ affectsConfiguration: (candidate) => candidate === section || section.startsWith(`${candidate}.`) });
  }
}

test('the bridge accepts exactly the four approval policies and nothing else', () => {
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous']) {
    assert.deepEqual(parseChatWebviewMessage({ type: 'set-action-policy', mode }), { type: 'set-action-policy', mode });
  }
  for (const bad of [{ type: 'set-action-policy' }, { type: 'set-action-policy', mode: 'yolo' }, { type: 'set-action-policy', mode: 'Auto' }, { type: 'set-action-policy', mode: 3 }, { type: 'set-action-policy', mode: 'auto', target: 'global' }, { type: 'set-action-policy', mode: ['auto'] }, { type: 'set-action-policy', mode: 'auto ' }]) {
    assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad));
  }
});

test('picker labels cover every mode, and their tooltips are the setting\'s enumDescriptions', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const setting = pkg.contributes.configuration.properties?.['nearAi.actionPolicy'] ?? (pkg.contributes.configuration as Array<{ properties: Record<string, unknown> }>).map((section) => section.properties['nearAi.actionPolicy']).find(Boolean);
  assert.deepEqual(setting.enum, [...POLICY_MODES]);
  assert.deepEqual(POLICY_OPTIONS.map((option) => option.mode), [...POLICY_MODES]);
  assert.deepEqual(POLICY_OPTIONS.map((option) => option.description), setting.enumDescriptions);
  assert.deepEqual(POLICY_OPTIONS.filter((option) => option.risky).map((option) => option.mode), ['fully-autonomous']);
  assert.match(POLICY_OPTIONS.find((option) => option.mode === 'fully-autonomous')!.description, /throwaway workspaces/);
});

test('a choice is written to user settings, or to the workspace or folder scope the effective value comes from', async () => {
  const confirm = async () => assert.fail('only Full auto asks');
  const fresh = new FakeConfiguration();
  const global = await applyPolicyChoice('mostly-autonomous', fresh, TARGETS, confirm);
  assert.deepEqual(fresh.writes, [{ key: 'actionPolicy', value: 'mostly-autonomous', target: TARGETS.Global }]);
  assert.equal(global.scope, 'global');
  assert.equal(global.text, 'Approval policy: Edits auto.');

  const workspace = new FakeConfiguration();
  workspace.values = { globalValue: 'auto', workspaceValue: 'approve-risky' };
  const result = await applyPolicyChoice('auto', workspace, TARGETS, confirm);
  assert.deepEqual(workspace.writes, [{ key: 'actionPolicy', value: 'auto', target: TARGETS.Workspace }]);
  assert.equal(workspace.get('actionPolicy', 'approve-risky'), 'auto', 'the change takes effect');
  assert.match(result.text, /workspace's settings/);

  const folder = new FakeConfiguration();
  folder.values = { workspaceValue: 'auto', workspaceFolderValue: 'mostly-autonomous' };
  assert.match((await applyPolicyChoice('approve-risky', folder, TARGETS, confirm)).text, /folder's settings/);
  assert.deepEqual(folder.writes, [{ key: 'actionPolicy', value: 'approve-risky', target: TARGETS.WorkspaceFolder }]);

  const rejected = new FakeConfiguration();
  assert.equal((await applyPolicyChoice('everything', rejected, TARGETS, confirm)).written, false);
  assert.deepEqual(rejected.writes, []);
});

test('Full auto needs a modal confirmation, and declining it writes nothing', async () => {
  const declined = new FakeConfiguration();
  const prompts: string[] = [];
  const result = await applyPolicyChoice('fully-autonomous', declined, TARGETS, async (message) => { prompts.push(message); return false; });
  assert.equal(result.written, false);
  assert.deepEqual(declined.writes, []);
  assert.match(prompts[0], /throwaway workspace/);

  const accepted = new FakeConfiguration();
  assert.equal((await applyPolicyChoice('fully-autonomous', accepted, TARGETS, async () => true)).written, true);
  assert.deepEqual(accepted.writes, [{ key: 'actionPolicy', value: 'fully-autonomous', target: TARGETS.Global }]);
});

test('the emergency stop shows in the state without changing the stored mode', () => {
  const configuration = new FakeConfiguration();
  configuration.values = { globalValue: 'auto' };
  assert.deepEqual({ ...policyStateMessage(configuration, true), options: [] }, { type: 'action-policy', mode: 'auto', stopped: true, scope: 'global', options: [] });
  configuration.values = { workspaceValue: 'nonsense' };
  assert.equal(policyStateMessage(configuration, false).mode, 'approve-risky', 'an invalid value reads as the default');
});

test('only the chat host handler writes nearAi.actionPolicy; no agent tool or model path can', () => {
  const src = path.join(__dirname, '..', '..', 'src');
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) { if (name !== 'test') walk(full); } else if (full.endsWith('.ts')) files.push(full); } };
  walk(src);
  const relative = (file: string) => path.relative(src, file).replaceAll(path.sep, '/');
  const writers = files.filter((file) => /update\(\s*['"`](?:nearAi\.)?actionPolicy['"`]/.test(readFileSync(file, 'utf8'))).map(relative);
  assert.deepEqual(writers, ['services/approvalPolicy.ts']);
  const callers = files.filter((file) => /\bapplyPolicyChoice\s*\(/.test(readFileSync(file, 'utf8'))).map(relative).sort();
  assert.deepEqual(callers, ['services/approvalPolicy.ts', 'services/chat.ts']);
  const chat = readFileSync(path.join(src, 'services', 'chat.ts'), 'utf8');
  assert.equal(chat.match(/\bapplyPolicyChoice\s*\(/g)?.length, 1);
  const handler = chat.slice(chat.indexOf("if (message.type === 'set-action-policy')"));
  assert.ok(handler.indexOf('applyPolicyChoice(') < handler.indexOf('return;'), 'the call sits inside the webview message handler for the picker');
  for (const file of files.filter((candidate) => /\/(agent|gsd|mcp)\//.test(candidate.replaceAll(path.sep, '/')))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /approvalPolicy|ConfigurationTarget|actionPolicy['"`]\s*,/, relative(file));
  }
});

// Host path: the real attachChatToView with the VS Code API stubbed.

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const configuration = new FakeConfiguration();
const warnings: Array<{ message: string; options: unknown; items: string[] }> = [];
let warningAnswer: string | undefined;
const vscodeStub = {
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    name: 'demo',
    getConfiguration: () => configuration,
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
      configuration.listeners.push(listener);
      return { dispose: () => { configuration.listeners = configuration.listeners.filter((candidate) => candidate !== listener); } };
    }
  },
  window: {
    showInformationMessage: () => undefined,
    showWarningMessage: async (message: string, options: unknown, ...items: string[]) => { warnings.push({ message, options, items }); return warningAnswer; },
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} })
  },
  commands: { executeCommand: async () => undefined },
  ConfigurationTarget: TARGETS,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class { public constructor(public readonly id: string) {} },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

function withStub<T>(load: () => T): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try { return load(); } finally { nodeModule._load = originalLoad; }
}

async function openSidebar(root: string, auth: AuthService) {
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const { attachChatToView } = withStub(() => require('../services/chat') as typeof import('../services/chat'));
  const view = {
    webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} })
  };
  await attachChatToView({ subscriptions: [], globalStorageUri: { fsPath: path.join(root, '.global') }, extensionUri: { fsPath: root } } as never, auth, view as never, '<html></html>');
  const policies = () => posted.filter((message) => message.type === 'action-policy') as Array<{ mode: string; stopped: boolean; scope: string }>;
  return { posted, policies, send: (message: unknown) => receive!(message) };
}

const INFERENCE_ID = '0b6e3f9e-5a1d-5c2b-8f4e-1d2c3b4a5f60';

async function projectWithProfile() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-policy-'));
  const auth = new AuthService(new MemorySecrets());
  const profiles = new ProfileStore(root, auth, { validator: async () => undefined });
  await profiles.configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  return { root, auth };
}

test('the sidebar shows the effective policy, follows settings edits, and confirms before Full auto', async () => {
  configuration.values = {};
  configuration.writes = [];
  warnings.length = 0;
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-policy-empty-'));
  const sidebar = await openSidebar(root, new AuthService(new MemorySecrets()));
  assert.deepEqual(sidebar.policies().map(({ mode, stopped, scope }) => ({ mode, stopped, scope })), [{ mode: 'approve-risky', stopped: false, scope: 'default' }]);

  // Editing settings.json: the picker follows without a reload.
  configuration.values = { workspaceValue: 'auto' };
  configuration.fire('nearAi.actionPolicy');
  assert.deepEqual(sidebar.policies().at(-1), { ...sidebar.policies().at(-1), mode: 'auto', scope: 'workspace' });
  const before = sidebar.policies().length;
  configuration.fire('nearAi.defaultModel');
  assert.equal(sidebar.policies().length, before, 'unrelated settings do not push');

  // The user picks Edits auto: it is written where it takes effect, and the picker updates.
  await sidebar.send({ type: 'set-action-policy', mode: 'mostly-autonomous' });
  assert.deepEqual(configuration.writes, [{ key: 'actionPolicy', value: 'mostly-autonomous', target: TARGETS.Workspace }]);
  assert.equal(sidebar.policies().at(-1)?.mode, 'mostly-autonomous');
  assert.match(String(sidebar.posted.filter((message) => message.type === 'notice').at(-1)?.text), /workspace's settings/);

  // Full auto, declined: a modal warning, nothing written, and the picker snaps back.
  warningAnswer = undefined;
  await sidebar.send({ type: 'set-action-policy', mode: 'fully-autonomous' });
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].options, { modal: true });
  assert.equal(configuration.writes.length, 1);
  assert.equal(sidebar.policies().at(-1)?.mode, 'mostly-autonomous');

  // Accepted.
  warningAnswer = warnings[0].items[0];
  await sidebar.send({ type: 'set-action-policy', mode: 'fully-autonomous' });
  assert.deepEqual(configuration.writes.at(-1), { key: 'actionPolicy', value: 'fully-autonomous', target: TARGETS.Workspace });
  assert.equal(sidebar.policies().at(-1)?.mode, 'fully-autonomous');

  // A forged message from the webview is dropped before the host handler.
  await sidebar.send({ type: 'set-action-policy', mode: 'root' });
  assert.equal(configuration.writes.length, 2);

  // The emergency stop shows as stopped and leaves the stored mode alone.
  const stop = withStub(() => require('../services/emergencyStop') as typeof import('../services/emergencyStop'));
  const memento = new Map<string, unknown>();
  stop.initEmergencyStop({ globalState: { get: (key: string, fallback: unknown) => memento.has(key) ? memento.get(key) : fallback, update: async (key: string, value: unknown) => { memento.set(key, value); } }, subscriptions: [] } as never);
  await stop.setEmergencyStop(true);
  assert.deepEqual({ mode: sidebar.policies().at(-1)?.mode, stopped: sidebar.policies().at(-1)?.stopped }, { mode: 'fully-autonomous', stopped: true });
  await stop.setEmergencyStop(false);
  assert.equal(sidebar.policies().at(-1)?.stopped, false);
  assert.equal(configuration.writes.length, 2);
});

test('a run started after the user picks a new policy uses it', async () => {
  configuration.values = {};
  configuration.writes = [];
  const { root, auth } = await projectWithProfile();
  await writeFile(path.join(root, 'app.ts'), 'export const port = 3000;\n');
  let turn = 0;
  const script = [
    { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"app.ts"}' } }] },
    { tool_calls: [{ index: 0, id: 'call_edit', function: { name: 'Edit', arguments: '{"file_path":"app.ts","old_string":"3000","new_string":"8080"}' } }] },
    { content: 'Changed the port.' }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/models/pricing')) return new Response('{}', { status: 404 });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1.8, output: 5.75 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }] });
    if (url.endsWith('/billing/costs')) return Response.json({ requests: [] });
    if (url.endsWith('/chat/completions')) {
      const delta = script[turn++] ?? { content: 'done' };
      const body = [`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}`, 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}', 'data: [DONE]', ''].join('\n\n');
      return new Response(body, { headers: { 'inference-id': INFERENCE_ID } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  try {
    const sidebar = await openSidebar(root, auth);
    await sidebar.send({ type: 'set-action-policy', mode: 'mostly-autonomous' });
    assert.deepEqual(configuration.writes, [{ key: 'actionPolicy', value: 'mostly-autonomous', target: TARGETS.Global }]);
    await sidebar.send({ type: 'send', text: 'Use port 8080', model: 'z-ai/glm-5.3' });
    assert.equal(sidebar.posted.some((message) => message.type === 'approval-request'), false, 'Edits auto runs the edit without asking');
    assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'export const port = 8080;\n');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
