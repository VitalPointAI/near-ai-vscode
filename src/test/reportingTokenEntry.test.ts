// Where the user finds the usage reporting token. It used to be only a Command Palette command
// (NEAR AI: Set Usage Reporting Token); now every place that shows spend links to it with the
// same words: Settings, the chat's spend line, Spending Limits, Agent Activity, and the Tools
// tab's Elsewhere row. A token pasted into a setting is moved to SecretStorage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { deriveProfileId } from '../domain/auth';
import { ProfileStore } from '../services/profileStore';
import { parseChatWebviewMessage } from '../services/chatBridge';
import {
  CLEAR_REPORTING_TOKEN_COMMAND, findPastedReportingTokens, movePastedReportingTokens, REPORTING_TOKEN_HOW_TO, reportingTokenHint, SET_REPORTING_TOKEN_COMMAND,
  TOKEN_MISSING_TEXT, TOKEN_SET_TEXT, USE_NEAR_TOTAL_SETTING, withoutTokenAt
} from '../services/reportingToken';
import { buildToolsDirectory, parseToolsPageMessage } from '../services/toolsDirectory';
import { DEFAULT_RULES } from '../agent/permissions';

const ROOT = path.join(__dirname, '..', '..');
const TOKEN = 'rpt-0123456789abcdef0123456789abcdef';
const KEY = 'nearAi.usageReportingToken';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

// ---- one VS Code stand-in for the whole file (each test file runs in its own process) ----

const TARGET = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
/** Settings by scope, as settings.json files would hold them (keys below `nearAi`). */
const scopes: Record<'global' | 'workspace' | 'folder', Record<string, unknown>> = { global: {}, workspace: {}, folder: {} };
const configListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
const executed: unknown[][] = [];
const warnings: string[] = [];
const infos: string[] = [];
const commands = new Map<string, (...args: unknown[]) => unknown>();
let inputBox: ((options: Record<string, unknown>) => Promise<string | undefined>) | undefined;
let quickPick: ((items: Array<Record<string, unknown>>, options: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>) | undefined;

function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = value;
  }
  return out;
}
function configuration() {
  const merged = { ...scopes.global, ...scopes.workspace, ...scopes.folder };
  return {
    ...nest(merged),
    get: <T>(key: string, fallback?: T) => (key in merged ? merged[key] : fallback) as T,
    has: (key: string) => key in merged,
    inspect: (key: string) => ({ key, globalValue: scopes.global[key], workspaceValue: scopes.workspace[key], workspaceFolderValue: scopes.folder[key] }),
    update: async (key: string, value: unknown, target: number) => {
      const scope = target === TARGET.Global ? scopes.global : target === TARGET.Workspace ? scopes.workspace : scopes.folder;
      if (value === undefined) delete scope[key]; else scope[key] = value;
    }
  };
}
const changeSettings = (keys: string[]) => { for (const listener of configListeners) listener({ affectsConfiguration: (section) => keys.some((key) => `nearAi.${key}` === section || `nearAi.${key}`.startsWith(`${section}.`) || section === 'nearAi') }); };

const vscodeStub = {
  ConfigurationTarget: TARGET,
  QuickPickItemKind: { Separator: -1 },
  ViewColumn: { Active: -1 },
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string; path?: string } }>,
    name: 'demo',
    getConfiguration: () => configuration(),
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => { configListeners.push(listener); return { dispose() {} }; }
  },
  window: {
    showWarningMessage: async (text: string) => { warnings.push(text); return undefined; },
    showInformationMessage: async (text: string) => { infos.push(text); return undefined; },
    showErrorMessage: async () => undefined,
    showInputBox: async (options: Record<string, unknown>) => inputBox?.(options),
    showQuickPick: async (items: Array<Record<string, unknown>>, options: Record<string, unknown>) => quickPick?.(items, options),
    createWebviewPanel: () => activityPanel,
    activeTextEditor: undefined
  },
  commands: {
    registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { commands.set(name, handler); return { dispose() {} }; },
    executeCommand: async (...args: unknown[]) => { executed.push(args); }
  },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts), path: path.join(base.fsPath, ...parts), toString: () => path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

const activityHandlers: { message?: (value: unknown) => unknown } = {};
const activityPosted: Array<Record<string, unknown>> = [];
const activityPanel = {
  visible: true, iconPath: undefined as unknown,
  webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (value: unknown) => value, postMessage: async (message: Record<string, unknown>) => { activityPosted.push(message); return true; }, onDidReceiveMessage: (handler: (value: unknown) => unknown) => { activityHandlers.message = handler; return { dispose() {} }; } },
  onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal: () => undefined
};

function load<T>(id: string): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try { return require(id) as T; } finally { nodeModule._load = originalLoad; }
}
const tracking = load<typeof import('../services/spendTracking')>('../services/spendTracking');
const secrets = new MemorySecrets();
const storage = path.join(tmpdir(), `near-ai-token-${process.pid}`);
const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: storage }, extensionUri: { fsPath: ROOT, path: ROOT }, secrets, workspaceState: { get: () => undefined, update: async () => undefined } };
tracking.registerSpendTracking(context as never);
const reset = () => { executed.length = 0; warnings.length = 0; infos.length = 0; for (const scope of Object.values(scopes)) for (const key of Object.keys(scope)) delete scope[key]; };

// ---- the words, the setting, and the guard ----

test('every entry point says the same thing: set a token to match the console, or that NEAR\'s total is in use', () => {
  const missing = reportingTokenHint('missing');
  assert.equal(missing.text, 'Match the NEAR console exactly: set a usage reporting token');
  assert.equal(missing.command, SET_REPORTING_TOKEN_COMMAND);
  assert.match(missing.title, /POST \/v1\/organizations\/\{org_id\}\/reporting-tokens/);
  const set = reportingTokenHint('set');
  assert.equal(set.text, 'Using NEAR\'s total');
  assert.equal(set.command, SET_REPORTING_TOKEN_COMMAND, 'clicking it replaces the token');
  const off = reportingTokenHint('off');
  assert.deepEqual([off.command, off.args], ['workbench.action.openSettings', [USE_NEAR_TOTAL_SETTING]], 'a stored token with NEAR\'s total turned off links to the switch');
  assert.match(REPORTING_TOKEN_HOW_TO, /organization owner or admin/);
  assert.match(REPORTING_TOKEN_HOW_TO, /console session token \(it is not in the console UI\)/);
  assert.match(REPORTING_TOKEN_HOW_TO, /starts with rpt-/);
});

test('Settings: a NEAR AI setting next to the daily limit links to set and clear the token, and never holds it', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { type: string; default: unknown; order?: number; markdownDescription?: string; description?: string }> }; commands: Array<{ command: string; title: string }> } };
  const properties = manifest.contributes.configuration.properties;
  const setting = properties[USE_NEAR_TOTAL_SETTING];
  assert.ok(setting, 'contributed');
  assert.equal(setting.type, 'boolean', 'an on/off switch: there is no text box to paste the token into');
  assert.equal(setting.default, true);
  assert.ok(setting.markdownDescription?.includes('[Set usage reporting token](command:nearAi.setUsageReportingToken)'));
  assert.ok(setting.markdownDescription?.includes('[Clear](command:nearAi.clearUsageReportingToken)'));
  assert.match(setting.markdownDescription!, /Match the NEAR AI console exactly/);
  assert.match(setting.markdownDescription!, /`POST \/v1\/organizations\/\{org_id\}\/reporting-tokens` with a NEAR AI Cloud console session token \(it is not in the console UI\); it starts with `rpt-`/);
  assert.match(setting.markdownDescription!, /never in settings/);
  assert.deepEqual(['nearAi.dailySpendLimitUsd', 'nearAi.spend.dayBoundary', USE_NEAR_TOTAL_SETTING].map((key) => properties[key].order), [1, 2, 3], 'shown together, in that order');
  for (const command of [SET_REPORTING_TOKEN_COMMAND, CLEAR_REPORTING_TOKEN_COMMAND]) assert.ok(manifest.contributes.commands.some((entry) => entry.command === command), command);
  for (const [key, value] of Object.entries(properties)) assert.ok(!/token/i.test(key) || value.type !== 'string', `${key} must not be a place to type a token`);
});

test('a token pasted into any NEAR AI setting moves to SecretStorage and out of every scope that holds it', async () => {
  const config = {
    baseUrl: TOKEN,
    agent: { roleModels: { planner: ` ${TOKEN} `, coder: 'z-ai/glm-5.3' }, allowCommands: ['git status'] },
    spend: { dayBoundary: 'local' },
    inspect: (key: string) => ({ baseUrl: { globalValue: TOKEN }, 'agent.roleModels': { workspaceValue: { planner: ` ${TOKEN} `, coder: 'z-ai/glm-5.3' } } } as Record<string, object>)[key] ?? {},
    update: async (key: string, value: unknown, target: number) => { updates.push([key, value, target]); }
  };
  const updates: unknown[][] = [];
  const stored: string[] = [];
  const notices: string[] = [];
  assert.deepEqual(findPastedReportingTokens(config).map((found) => found.path.join('.')), ['baseUrl', 'agent.roleModels.planner']);
  const cleared = await movePastedReportingTokens({ configuration: config, targets: TARGET, storeToken: async (token) => { stored.push(token); }, notify: (message) => notices.push(message) });
  assert.deepEqual(cleared, ['nearAi.baseUrl', 'nearAi.agent.roleModels']);
  assert.deepEqual(updates, [['baseUrl', undefined, TARGET.Global], ['agent.roleModels', { coder: 'z-ai/glm-5.3' }, TARGET.Workspace]], 'only the token is removed; the other role model stays');
  assert.deepEqual(stored, [TOKEN], 'trimmed, stored once');
  assert.match(notices[0], /moved to VS Code's encrypted secret storage and removed from settings/);
  assert.deepEqual(withoutTokenAt(['a', TOKEN, 'b'], ['1']), ['a', 'b']);

  const clean = { baseUrl: 'https://cloud-api.near.ai/v1', inspect: () => ({}), update: async () => { assert.fail('nothing to clear'); } };
  assert.deepEqual(await movePastedReportingTokens({ configuration: clean, targets: TARGET, storeToken: async () => assert.fail('nothing to store'), notify: () => assert.fail('nothing to say') }), []);
});

test('the guard runs when settings change: the pasted token is stored as the reporting token and the setting is cleared', async () => {
  reset();
  secrets.values.clear();
  let changes = 0;
  const watch = tracking.onReportingTokenChange(() => { changes += 1; });
  scopes.global['spend.usageReportingToken'] = TOKEN;
  changeSettings(['spend.usageReportingToken']);
  for (let wait = 0; wait < 50 && !secrets.values.has(KEY); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  watch.dispose();
  assert.equal(secrets.values.get(KEY), TOKEN);
  assert.equal('spend.usageReportingToken' in scopes.global, false, 'removed from settings.json');
  assert.match(warnings.join('\n'), /in the setting nearAi\.spend\.usageReportingToken/);
  assert.ok(changes >= 1, 'open views refresh their link');
  assert.equal(await tracking.reportingTokenState(), 'set');
});

test('the command\'s input box says how to get a token, and setting or clearing it updates the state', async () => {
  reset();
  secrets.values.clear();
  let options: Record<string, unknown> = {};
  inputBox = async (shown) => { options = shown; return ` ${TOKEN} `; };
  assert.equal(await tracking.reportingTokenState(), 'missing');
  await commands.get(SET_REPORTING_TOKEN_COMMAND)!();
  assert.match(String(options.prompt), /^Match the NEAR AI console exactly/);
  assert.match(String(options.prompt), /POST \/v1\/organizations\/\{org_id\}\/reporting-tokens, authenticated with a NEAR AI Cloud console session token \(it is not in the console UI\)\. It starts with rpt-\./);
  assert.equal(options.password, true);
  const validate = options.validateInput as (value: string) => string | undefined;
  assert.match(String(validate('sk-not-a-token')), /starts with "rpt-".*POST \/v1\/organizations\/\{org_id\}\/reporting-tokens/);
  assert.equal(validate(TOKEN), undefined);
  assert.equal(secrets.values.get(KEY), TOKEN);
  assert.equal(await tracking.reportingTokenState(), 'set');
  // nearAi.spend.useNearUsageTotal off: the token is kept but not used, and the link says so.
  scopes.global['spend.useNearUsageTotal'] = false;
  assert.equal(await tracking.reportingTokenState(), 'off');
  assert.equal((await tracking.currentReportingTokenHint())?.command, 'workbench.action.openSettings');
  delete scopes.global['spend.useNearUsageTotal'];
  await commands.get(CLEAR_REPORTING_TOKEN_COMMAND)!();
  assert.equal(secrets.values.has(KEY), false);
  assert.equal(await tracking.reportingTokenState(), 'missing');
  inputBox = undefined;
});

test('with nearAi.spend.useNearUsageTotal off, spend accounts get no token (this computer\'s ledger only)', async () => {
  reset();
  secrets.values.set(KEY, TOKEN);
  const { spendAccountFor } = load<typeof import('../services/spendAccount')>('../services/spendAccount');
  const account = spendAccountFor('https://cloud-api.near.ai/v1', 'sk-test-off')!;
  const token = () => (account.usage as unknown as { options: { token(): Promise<string | undefined> } }).options.token();
  assert.equal(await token(), TOKEN);
  scopes.global['spend.useNearUsageTotal'] = false;
  assert.equal(await token(), undefined);
  delete scopes.global['spend.useNearUsageTotal'];
  account.dispose();
  secrets.values.clear();
});

// ---- the entry points ----

test('Spending Limits lists "Set usage reporting token…" and, once one is set, "Clear usage reporting token"', async () => {
  reset();
  const { registerSpendingLimits, reportingTokenItems } = load<typeof import('../services/spendingLimits')>('../services/spendingLimits');
  assert.deepEqual(reportingTokenItems('missing').map((item) => [item.label, item.description]), [['Set usage reporting token…', 'Match the NEAR console exactly']]);
  assert.match(String(reportingTokenItems('missing')[0].detail), /reporting-tokens/);
  assert.deepEqual(reportingTokenItems('set').map((item) => item.label), ['Set usage reporting token…', 'Clear usage reporting token']);
  registerSpendingLimits(context as never, new AuthService(new MemorySecrets()));
  const shown: string[][] = [];
  const picks = ['Set usage reporting token…', 'Clear usage reporting token'];
  secrets.values.set(KEY, TOKEN);
  quickPick = async (items) => { shown.push(items.map((item) => String(item.label))); const label = picks.shift(); return label ? items.find((item) => item.label === label) : undefined; };
  await commands.get('nearAi.spendingLimits')!();
  quickPick = undefined;
  assert.deepEqual(shown[0], ['Daily spend limit', 'Cost limit per run', 'Token limit per run', 'NEAR\'s own total', 'Set usage reporting token…', 'Clear usage reporting token']);
  assert.deepEqual(executed, [[SET_REPORTING_TOKEN_COMMAND], [CLEAR_REPORTING_TOKEN_COMMAND]], 'each item runs its command, then the list comes back');
  secrets.values.clear();
});

test('the chat: the spend line links to the token, and the link runs the command', async () => {
  reset();
  secrets.values.clear();
  // The view only asks; the message carries nothing the host would run.
  assert.deepEqual(parseChatWebviewMessage({ type: 'reporting-token' }), { type: 'reporting-token' });
  assert.equal(parseChatWebviewMessage({ type: 'reporting-token', command: 'workbench.action.terminal.new' }), undefined);
  const view = readFileSync(path.join(ROOT, 'src', 'services', 'panelView.ts'), 'utf8');
  assert.ok(view.indexOf('id="status"') < view.indexOf('<button id="spend-token" class="link" type="button" hidden></button>'), 'right below the status line');
  const script = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /spendToken\.addEventListener\('click', \(\) => post\(\{ type: 'reporting-token' \}\)\)/);
  assert.match(script, /spendToken\.textContent = token\.text/);

  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-token-chat-'));
  const auth = new AuthService(new MemorySecrets());
  await new ProfileStore(root, auth, { validator: async () => undefined }).configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1, output: 1 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const sidebar = { webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }) };
  try {
    const { attachChatToView } = load<typeof import('../services/chat')>('../services/chat');
    await attachChatToView(context as never, auth, sidebar as never, '<html></html>');
    const status = () => posted.filter((message) => message.type === 'status').at(-1) as { token?: { state: string; text: string; title: string } } | undefined;
    assert.deepEqual([status()?.token?.state, status()?.token?.text], ['missing', TOKEN_MISSING_TEXT]);
    assert.match(String(status()?.token?.title), /reporting-tokens/);
    await receive!({ type: 'reporting-token' });
    assert.deepEqual(executed.at(-1), [SET_REPORTING_TOKEN_COMMAND]);
    // Once a token is set (from anywhere), the line says NEAR's total is in use.
    inputBox = async () => TOKEN;
    await commands.get(SET_REPORTING_TOKEN_COMMAND)!();
    inputBox = undefined;
    for (let wait = 0; wait < 50 && status()?.token?.text !== TOKEN_SET_TEXT; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(status()?.token?.text, TOKEN_SET_TEXT);
  } finally {
    globalThis.fetch = originalFetch;
    secrets.values.clear();
  }
});

test('Agent Activity: the cost header links to the token, and the link runs the command', async () => {
  reset();
  secrets.values.clear();
  const view = load<typeof import('../services/activityView')>('../services/activityView');
  assert.deepEqual(view.parseActivityViewMessage({ type: 'reporting-token' }), { type: 'reporting-token' });
  const html = view.activityHtml({ asWebviewUri: (value: unknown) => value, cspSource: 'x' } as never, { fsPath: '/media', path: '/media' } as never);
  assert.match(html, /<p id="token-line" class="hint" hidden><button id="reporting-token" type="button" class="link"><\/button><\/p>\s*<p id="summary-empty"/);
  const script = readFileSync(path.join(ROOT, 'media', 'activity', 'activity.js'), 'utf8');
  assert.match(script, /\$\('reporting-token'\)\.addEventListener\('click', \(\) => vscode\.postMessage\(\{ type: 'reporting-token' \}\)\)/);
  assert.match(script, /setText\(link, token\.text\)/);
  // Without a NEAR AI Cloud ledger (local models) there is no NEAR bill to match: no link.
  assert.equal(view.overviewMessage({ feed: view.sharedActivityFeed(), sessions: [], window: 'today', page: 0, token: reportingTokenHint('missing') }).token, undefined);

  const { spendAccountFor, showSpendAccount } = load<typeof import('../services/spendAccount')>('../services/spendAccount');
  const account = spendAccountFor('https://cloud-api.near.ai/v1', 'sk-test-activity')!;
  showSpendAccount(account);
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: await mkdtemp(path.join(tmpdir(), 'near-ai-token-activity-')), path: '' } }];
  view.openAgentActivity(context as never);
  await activityHandlers.message?.({ type: 'ready' });
  const overview = () => activityPosted.filter((message) => message.type === 'overview').at(-1) as { token?: { state: string; text: string } } | undefined;
  for (let wait = 0; wait < 100 && !overview(); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([overview()?.token?.state, overview()?.token?.text], ['missing', TOKEN_MISSING_TEXT]);
  await activityHandlers.message?.({ type: 'reporting-token' });
  assert.deepEqual(executed.at(-1), [SET_REPORTING_TOKEN_COMMAND]);
  secrets.values.set(KEY, TOKEN);
  await activityHandlers.message?.({ type: 'set-window', window: 'today' });
  assert.equal(overview()?.token?.text, TOKEN_SET_TEXT);
  account.dispose();
  secrets.values.clear();
});

test('Tools tab: the Elsewhere row links to the token (or to the switch when NEAR\'s total is off)', () => {
  const base = {
    teams: [], policy: { mode: 'approve-risky' as const, emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: false, mcp: [],
    settings: { mainModel: 'm', tiers: { deep: 'm', standard: 'm', fast: 'm' }, roleModels: {}, visionModel: 'm', transcriptionModel: 'm', imageModel: 'm', safetyModel: 'm' }
  };
  assert.equal(buildToolsDirectory(base).reportingToken, undefined);
  assert.deepEqual(buildToolsDirectory({ ...base, reportingToken: reportingTokenHint('missing') }).reportingToken, { state: 'missing', text: TOKEN_MISSING_TEXT, title: reportingTokenHint('missing').title, command: SET_REPORTING_TOKEN_COMMAND });
  assert.equal(buildToolsDirectory({ ...base, reportingToken: reportingTokenHint('off') }).reportingToken?.command, `setting:${USE_NEAR_TOTAL_SETTING}`);
  assert.deepEqual(parseToolsPageMessage({ type: 'run-command', command: SET_REPORTING_TOKEN_COMMAND }), { type: 'run-command', command: SET_REPORTING_TOKEN_COMMAND }, 'the page may run it');
  assert.deepEqual(parseToolsPageMessage({ type: 'open-setting', key: USE_NEAR_TOTAL_SETTING }), { type: 'open-setting', key: USE_NEAR_TOTAL_SETTING });
  const script = readFileSync(path.join(ROOT, 'media', 'tools', 'tools.js'), 'utf8');
  assert.match(script, /const token = data && data\.reportingToken;/);
  assert.match(script, /runCommand\(token\.text, token\.command\)/);
});
