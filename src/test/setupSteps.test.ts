// What happens after NEAR AI is connected (0.4.14): the extension suggests the next step, starting
// with setting up the project team, from an ordered list of setup steps that later features (Team
// Mode: where the project is kept, who else works on it) extend without changing the menu.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SecretStorageLike } from '../services/auth';
import {
  buildSetupMenu, projectHasTeam, projectTeamFiles, SETUP_NUDGE_DISMISSED_KEY, SETUP_STEPS, SetupContext, SetupStep, shouldShowSetupNudge, START_CHATTING, withSetupStep
} from '../services/setupSteps';

const ROOT = path.join(__dirname, '..', '..');

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const emptyProject = () => mkdtemp(path.join(tmpdir(), 'near-ai-setup-steps-'));
const facts = (root: string, settings: Record<string, unknown> = {}, webSearch = false): SetupContext => ({ root, setting: (key) => settings[key], webSearchReady: () => webSearch });
async function withTeam(root: string, file: 'team.md' | 'project.json'): Promise<void> {
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, '.planning', '.near-ai', file), file === 'team.md' ? '# Team\n' : '{}\n');
}

// ---- the steps and the menu (no VS Code) ----

test('the setup steps are the project team, a spending limit and web search, in that order, then Start chatting', () => {
  assert.deepEqual(SETUP_STEPS.map((step) => [step.id, step.command]), [
    ['project-team', 'nearAi.setupProjectTeam'],
    ['spending-limit', 'nearAi.spendingLimits'],
    ['web-search', 'nearAi.setUpWebSearch']
  ]);
  assert.deepEqual([START_CHATTING.id, START_CHATTING.command], ['start-chatting', 'nearAi.openChat']);
});

test('a new project gets the team step first, marked recommended, and Start chatting last', async () => {
  const menu = await buildSetupMenu(SETUP_STEPS, facts(await emptyProject()));
  assert.deepEqual(menu.map((item) => item.label), [
    '$(organization) Set up your project team (recommended)',
    '$(shield) Set a spending limit',
    '$(globe) Turn on web search',
    '$(comment-discussion) Start chatting'
  ]);
  assert.equal(menu[0].detail, 'Tell us what this project is for. We suggest a team of agents, the models they use and how they work.');
  assert.deepEqual(menu.map((item) => item.recommended), [true, false, false, false]);
  assert.deepEqual(menu.map((item) => item.command), ['nearAi.setupProjectTeam', 'nearAi.spendingLimits', 'nearAi.setUpWebSearch', 'nearAi.openChat']);
});

test('done steps move below the ones still to do, with a check and "(done)", so they can be revisited', async () => {
  const root = await emptyProject();
  await withTeam(root, 'team.md');
  const menu = await buildSetupMenu(SETUP_STEPS, facts(root, { dailySpendLimitUsd: 0 }, true));
  assert.deepEqual(menu.map((item) => item.label), [
    '$(shield) Set a spending limit (recommended)',
    '$(check) Set up your project team (done)',
    '$(check) Turn on web search (done)',
    '$(comment-discussion) Start chatting'
  ]);
  assert.deepEqual(menu.map((item) => item.done), [false, true, true, false]);
  // Everything done: no step is recommended, and Start chatting is still last.
  const all = await buildSetupMenu(SETUP_STEPS, facts(root, { dailySpendLimitUsd: 25 }, true));
  assert.deepEqual(all.map((item) => item.id), ['project-team', 'spending-limit', 'web-search', 'start-chatting']);
  assert.equal(all.some((item) => item.recommended), false);
  assert.equal(all[0].command, 'nearAi.setupProjectTeam', 'a done step still runs its command');
});

test('a step registered between the team and the spending limit needs no change to the menu', async () => {
  const step = (id: string, label: string, done: boolean): SetupStep => ({ id, label, detail: `${label}.`, icon: 'repo', command: `nearAi.${id}`, isDone: () => done });
  const steps = withSetupStep(withSetupStep(SETUP_STEPS, step('repository', 'Choose where the project is kept', false), 'project-team'), step('invite-people', 'Invite people', false), 'repository');
  assert.deepEqual(steps.map((entry) => entry.id), ['project-team', 'repository', 'invite-people', 'spending-limit', 'web-search']);
  assert.deepEqual(SETUP_STEPS.map((entry) => entry.id), ['project-team', 'spending-limit', 'web-search'], 'the registry itself is unchanged');
  const root = await emptyProject();
  await withTeam(root, 'project.json');
  const menu = await buildSetupMenu(steps, facts(root));
  assert.deepEqual(menu.map((item) => item.id), ['repository', 'invite-people', 'spending-limit', 'web-search', 'project-team', 'start-chatting']);
  assert.equal(menu[0].label, '$(repo) Choose where the project is kept (recommended)');
  // Registering a step again replaces it; an unknown anchor puts it at the end.
  assert.deepEqual(withSetupStep(steps, step('repository', 'Again', false), 'web-search').map((entry) => entry.id), ['project-team', 'invite-people', 'spending-limit', 'web-search', 'repository']);
  assert.deepEqual(withSetupStep(SETUP_STEPS, step('extra', 'Extra', false), 'missing').map((entry) => entry.id).at(-1), 'extra');
});

test('an unavailable step is left out, and a step whose check fails is offered as not done', async () => {
  const hidden: SetupStep = { ...SETUP_STEPS[1], id: 'hidden', isAvailable: () => false };
  const broken: SetupStep = { ...SETUP_STEPS[2], id: 'broken', isDone: () => { throw new Error('no settings'); } };
  const menu = await buildSetupMenu([hidden, broken], facts(await emptyProject()));
  assert.deepEqual(menu.map((item) => [item.id, item.done]), [['broken', false], ['start-chatting', false]]);
});

test('a project has a team once team.md or project.json exists', async () => {
  const root = await emptyProject();
  assert.deepEqual(projectTeamFiles(root), [path.join(root, '.planning', '.near-ai', 'team.md'), path.join(root, '.planning', '.near-ai', 'project.json')]);
  assert.equal(await projectHasTeam(root), false);
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  assert.equal(await projectHasTeam(root), false, 'the folder alone is not a team');
  await withTeam(root, 'project.json');
  assert.equal(await projectHasTeam(root), true);
  const other = await emptyProject();
  await withTeam(other, 'team.md');
  assert.equal(await projectHasTeam(other), true);
});

test('the chat card shows only with a working profile, no team, and no "Not now"', () => {
  assert.equal(shouldShowSetupNudge({ workingProfile: true, hasTeam: false, dismissed: false }), true);
  assert.equal(shouldShowSetupNudge({ workingProfile: false, hasTeam: false, dismissed: false }), false);
  assert.equal(shouldShowSetupNudge({ workingProfile: true, hasTeam: true, dismissed: false }), false);
  assert.equal(shouldShowSetupNudge({ workingProfile: true, hasTeam: false, dismissed: true }), false);
  assert.equal(SETUP_NUDGE_DISMISSED_KEY, 'nearAi.setupNudge.dismissed');
});

test('setup texts are plain words: no dashes for punctuation, no developer terms, short labels', () => {
  const texts = [...SETUP_STEPS.flatMap((step) => [step.label, step.detail]), START_CHATTING.label, START_CHATTING.detail];
  for (const text of texts) {
    assert.doesNotMatch(text, /[—–]| - /, text);
    assert.doesNotMatch(text, /\b(git|repo|commit|branch|config|JSON|API|workspaceState|command palette)\b/i, text);
  }
  for (const step of SETUP_STEPS) assert.ok(step.label.length <= 30, step.label);
});

// ---- the host side, against a VS Code stand-in ----

const executed: unknown[][] = [];
let webviewPanel: unknown;
const infos: Array<{ text: string; items: string[] }> = [];
const picks: Array<{ items: Array<Record<string, unknown>>; options: Record<string, unknown> }> = [];
const commands = new Map<string, (...args: unknown[]) => unknown>();
const settings: Record<string, unknown> = {};
let quickPick: (items: Array<Record<string, unknown>>) => Record<string, unknown> | undefined = () => undefined;
let infoChoice: string | undefined;
let inputBoxes: string[] = [];

const vscodeStub = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { One: 1 },
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    name: 'Demo',
    getConfiguration: () => ({ get: <T>(key: string, fallback?: T) => (key in settings ? settings[key] : fallback) as T, inspect: () => undefined, update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} })
  },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async (text: string) => { throw new Error(`unexpected error: ${text}`); },
    showInformationMessage: async (text: string, ...items: string[]) => { infos.push({ text, items }); return infoChoice; },
    showQuickPick: async (items: Array<Record<string, unknown>>, options: Record<string, unknown>) => { picks.push({ items, options }); return quickPick(items); },
    showInputBox: async () => inputBoxes.shift(),
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
    createWebviewPanel: () => webviewPanel,
    createOutputChannel: () => ({ appendLine() {}, dispose() {} })
  },
  commands: {
    registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { commands.set(name, handler); return { dispose() {} }; },
    executeCommand: async (...args: unknown[]) => { executed.push(args); }
  },
  env: {},
  UIKind: { Desktop: 1, Web: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath }), parse: (value: string) => ({ toString: () => value }), joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
};

function load<T>(id: string): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try { return require(id) as T; } finally { nodeModule._load = originalLoad; }
}
const reset = () => { executed.length = 0; infos.length = 0; picks.length = 0; infoChoice = undefined; quickPick = () => undefined; inputBoxes = []; for (const key of Object.keys(settings)) delete settings[key]; };
const secrets = new MemorySecrets();
const context = { subscriptions: [] as unknown[], secrets };
const menu = load<typeof import('../services/setupMenu')>('../services/setupMenu');

test('NEAR AI: Project Setup opens the menu at any time, and runs the step picked', async () => {
  reset();
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: await emptyProject() } }];
  menu.registerProjectSetup(context as never);
  quickPick = (items) => items.find((item) => String(item.label).includes('spending limit'));
  await commands.get('nearAi.projectSetup')!();
  assert.equal(picks[0].options.title, 'Project Setup');
  assert.equal(picks[0].options.ignoreFocusOut, true);
  assert.deepEqual(executed, [['nearAi.spendingLimits']]);
  // Closing the menu is "Start chatting": the chat opens, nothing else is asked.
  reset();
  await commands.get('nearAi.projectSetup')!();
  assert.deepEqual(executed, [['nearAi.openChat']]);
  assert.equal(infos.length, 0);
});

test('the menu marks web search done once a provider is set up', async () => {
  reset();
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: await emptyProject() } }];
  settings['webSearch.provider'] = 'brave';
  await secrets.store('nearAi.webSearch.brave.apiKey', 'brave-test-key-123');
  settings.dailySpendLimitUsd = 10;
  await menu.showSetupMenu(context as never);
  assert.deepEqual(picks[0].items.map((item) => item.label), ['$(organization) Set up your project team (recommended)', '$(check) Set a spending limit (done)', '$(check) Turn on web search (done)', '$(comment-discussion) Start chatting']);
  secrets.values.clear();
});

// The real NEAR AI: Set Up flow, from "Where should models run?" to what comes after the key is checked.
async function runSetUp(root: string): Promise<void> {
  const { configureApiKey } = load<typeof import('../extension')>('../extension');
  const { AuthService } = load<typeof import('../services/auth')>('../services/auth');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/models') ? Response.json({ data: [{ id: 'fake-coder' }] }) : new Response('{}', { status: 404 })) as typeof fetch;
  let refreshed = 0;
  // Local runtime: project name, organization, runtime address, runtime key.
  inputBoxes = ['Demo', '', 'http://127.0.0.1:11434/v1', ''];
  const first = quickPick;
  let asked = 0;
  quickPick = (items) => (asked++ === 0 ? items.find((item) => item.provider === 'local') : first(items));
  try {
    await configureApiKey({ ...context, secrets: new MemorySecrets() } as never, new AuthService(new MemorySecrets()), { refresh: async () => { refreshed += 1; } } as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(refreshed, 1, 'the sidebar reloads before the next step is offered');
}

test('after setup in a project without a team, the next step menu opens and runs the choice', async () => {
  reset();
  quickPick = (items) => items[0];
  await runSetUp(await emptyProject());
  const next = picks.at(-1)!;
  assert.equal(next.options.title, 'NEAR AI is ready for “Demo (local)”. What next?');
  assert.equal(next.options.ignoreFocusOut, true);
  assert.deepEqual(next.items.map((item) => item.label), ['$(organization) Set up your project team (recommended)', '$(shield) Set a spending limit', '$(globe) Turn on web search', '$(comment-discussion) Start chatting']);
  assert.deepEqual(executed, [['nearAi.setupProjectTeam']]);
  assert.equal(infos.length, 0, 'no bare "ready" message on top of the menu');
});

test('after setup, closing the next step menu just opens the chat', async () => {
  reset();
  await runSetUp(await emptyProject());
  assert.deepEqual(executed, [['nearAi.openChat']]);
});

test('after setup in a project that has a team, a short ready message offers to review it', async () => {
  reset();
  const root = await emptyProject();
  await withTeam(root, 'team.md');
  infoChoice = 'Review project team';
  await runSetUp(root);
  assert.equal(picks.length, 1, 'only "Where should models run?" was asked');
  assert.deepEqual(infos, [{ text: 'NEAR AI is ready for “Demo (local)”. Pick a model and start chatting.', items: ['Review project team'] }]);
  assert.deepEqual(executed, [['nearAi.manageTeams']]);
  reset();
  await withTeam(root, 'project.json');
  await runSetUp(root);
  assert.deepEqual(executed, [], 'dismissing the message does nothing more');
});

test('Project Setup is a contributed command and a Tools tab command', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  assert.deepEqual(manifest.contributes.commands.find((entry) => entry.command === 'nearAi.projectSetup'), { command: 'nearAi.projectSetup', title: 'Project Setup…', category: 'NEAR AI' });
  const { PAGE_COMMANDS, parseToolsPageMessage } = load<typeof import('../services/toolsDirectory')>('../services/toolsDirectory');
  assert.ok((PAGE_COMMANDS as readonly string[]).includes('nearAi.projectSetup'));
  assert.deepEqual(parseToolsPageMessage({ type: 'run-command', command: 'nearAi.projectSetup' }), { type: 'run-command', command: 'nearAi.projectSetup' });
  const tools = readFileSync(path.join(ROOT, 'media', 'tools', 'tools.js'), 'utf8');
  assert.match(tools, /\['Project setup', 'nearAi\.projectSetup'\]/);
});

test('the onboarding page lists setting up the project team right after connecting NEAR AI, and its button runs it', async () => {
  const { onboardingHtml, openOnboarding } = load<typeof import('../services/onboarding')>('../services/onboarding');
  const html = onboardingHtml({ cspSource: 'vscode-resource:' });
  const steps = [...html.matchAll(/<div class="number">(\d+)<\/div><strong>([^<]+)<\/strong>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(steps.slice(1, 3), [['02', 'Connect privately'], ['03', 'Choose your team']]);
  assert.deepEqual(steps.map((step) => step[0]), ['01', '02', '03', '04', '05', '06']);
  assert.match(html, /<button data-action="setup-project-team">Set up your project team<\/button>/);
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const panel = { webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } } };
  webviewPanel = panel;
  reset();
  openOnboarding({ subscriptions: [] } as never, { openApiKeyPortal: async () => undefined, configureApiKey: async () => undefined, showProgress: async () => undefined });
  await receive!({ type: 'setup-project-team' });
  assert.deepEqual(executed, [['nearAi.setupProjectTeam']]);
});
