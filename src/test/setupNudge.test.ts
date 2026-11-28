// The empty chat's "no team yet" card (0.4.14): shown while the project has a working profile and
// no project team, hidden for this project by "Not now", gone once a team is saved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { deriveProfileId } from '../domain/auth';
import { ProfileStore } from '../services/profileStore';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { SETUP_NUDGE_DISMISSED_KEY } from '../services/setupSteps';
import { applyStaffSetup, planStaffSetup } from '../services/staffSetup';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { J2_STAFF_TEMPLATE } from '../agent/staff/templates';
import { TeamLibrary } from '../agent/teams';
import { teamLibraryDir, homeFolder } from '../domain/teamStorage';
import { setNearAiDiagnostics } from '../services/nearAiClient';
import { FakeDocument, FakeNode } from './helpers/fakeDom';
import { testGateHost } from './helpers/gatedRuns';

const ROOT = path.join(__dirname, '..', '..');

// ---- the card in the view, against a small DOM stand-in (helpers/fakeDom.ts) ----

interface SetupKit {
  renderSetupNudge(doc: FakeDocument, container: FakeNode, show: boolean, post: (message: unknown) => void, afterDismiss?: () => void): FakeNode | undefined;
  welcomeState(value: unknown): 'no-folder' | 'ready' | 'choose' | 'select' | 'connect';
  applyWelcomeState(doc: FakeDocument, state: string, memory: Record<string, unknown>): FakeNode | undefined;
  focusBusy(doc: FakeDocument): boolean;
  WELCOME: Record<string, Record<string, string>>;
  TEXT: Record<string, string>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const setup = require(path.join(ROOT, 'media', 'chat', 'setup.js')) as SetupKit;

function emptyChat(): { doc: FakeDocument; welcome: FakeNode } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  welcome.append(doc.createElement('h2'));
  doc.body.append(welcome);
  return { doc, welcome };
}

test('the card sits at the top of the empty chat, labelled, with the team button first', () => {
  const { doc, welcome } = emptyChat();
  const posts: unknown[] = [];
  const card = setup.renderSetupNudge(doc, welcome, true, (message) => posts.push(message))!;
  assert.equal(welcome.children[0], card, 'above the welcome text');
  assert.equal(card.tagName, 'section');
  assert.equal(card.attributes.get('role'), 'region');
  assert.equal(card.attributes.get('aria-labelledby'), 'setup-nudge-title');
  assert.equal(doc.getElementById('setup-nudge-title')?.textContent, 'This project has no team yet');
  const buttons = card.all((node) => node.tagName === 'button');
  assert.deepEqual(buttons.map((button) => [button.textContent, button.type, button.className]), [
    ['Set up your project team', 'button', 'text-button primary'],
    ['Set up a staff team', 'button', 'text-button'],
    ['Not now', 'button', 'text-button'],
    ['All setup steps', 'button', 'link']
  ], 'real buttons, so they are reachable with Tab and work with Enter and Space');
  // Showing it again does not add a second card.
  assert.equal(setup.renderSetupNudge(doc, welcome, true, () => undefined), card);
  assert.equal(welcome.all((node) => node.id === 'setup-nudge').length, 1);
  assert.deepEqual(posts, []);
  for (const text of Object.values(setup.TEXT)) assert.doesNotMatch(text, /[—–]/, text);
});

test('the buttons ask the host, and "Not now" hides the card and returns focus', () => {
  const { doc, welcome } = emptyChat();
  const posts: unknown[] = [];
  let focused = 0;
  const card = setup.renderSetupNudge(doc, welcome, true, (message) => posts.push(message), () => { focused += 1; })!;
  const [team, staff, later, menu] = card.all((node) => node.tagName === 'button');
  team.click();
  staff.click();
  menu.click();
  assert.deepEqual(posts, [{ type: 'setup-nudge', action: 'team' }, { type: 'setup-nudge', action: 'staff' }, { type: 'setup-nudge', action: 'menu' }]);
  assert.equal(card.attached, true, 'the card stays until the team exists');
  later.click();
  assert.deepEqual(posts.at(-1), { type: 'setup-nudge', action: 'later' });
  assert.equal(card.attached, false);
  assert.equal(focused, 1);
});

test('the card disappears when the host says the project has a team', () => {
  const { doc, welcome } = emptyChat();
  setup.renderSetupNudge(doc, welcome, true, () => undefined);
  assert.equal(setup.renderSetupNudge(doc, welcome, false, () => undefined), undefined);
  assert.equal(doc.getElementById('setup-nudge'), undefined);
  // Hiding a card that is not there is fine.
  assert.equal(setup.renderSetupNudge(doc, welcome, false, () => undefined), undefined);
});

test('when the card goes away under the keyboard focus, focus moves to the message box', () => {
  const { doc, welcome } = emptyChat();
  let focused = 0;
  const card = setup.renderSetupNudge(doc, welcome, true, () => undefined)!;
  // Not focused inside: nothing moves.
  setup.renderSetupNudge(doc, welcome, false, () => undefined, () => { focused += 1; });
  assert.equal(focused, 0);
  const again = setup.renderSetupNudge(doc, welcome, true, () => undefined)!;
  assert.notEqual(again, card);
  doc.activeElement = again.all((node) => node.tagName === 'button')[0];
  setup.renderSetupNudge(doc, welcome, false, () => undefined, () => { focused += 1; });
  assert.equal(focused, 1);
});

test('the chat loads the card helper before chat.js, draws it in the welcome section, and styles it with theme colours', () => {
  const panel = readFileSync(path.join(ROOT, 'src', 'services', 'panelView.ts'), 'utf8');
  assert.ok(panel.indexOf("<script nonce=\"${nonce}\" src=\"${asset('setup.js')}\"></script>") > 0);
  assert.ok(panel.indexOf("asset('setup.js')") < panel.indexOf("asset('chat.js')"), 'setup.js loads before chat.js');
  const script = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /case 'setup-nudge': setupKit\.renderSetupNudge\(document, welcomeReady, m\.show === true, post, \(\) => input\.focus\(\)\); break;/);
  assert.match(script, /window\.nearSetup \|\| \{ renderSetupNudge: \(\) => undefined,/);
  // The card and the Connect panel ship hidden, and the host's first post at attach can arrive before
  // the page is listening. So the page asks for both itself once its listeners are in place: the host
  // answers refresh-status with the profile status and the card (see the host tests below).
  const listening = script.indexOf("window.addEventListener('message'");
  const asks = script.lastIndexOf("post({ type: 'refresh-status' });");
  assert.ok(listening > 0 && asks > listening, 'the page asks for the profile status and the card after it starts listening');
  const css = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.css'), 'utf8');
  const rules = css.split('\n').filter((line) => line.includes('setup-nudge')).join('\n');
  assert.match(rules, /\.setup-nudge \{/);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'no fixed colours');
  assert.match(rules, /var\(--vscode-/);
});

// ---- the welcome before a working profile ----

const profile = (id: string, status: string) => ({ profileId: id, displayName: id, validation: { status } });
const profileValue = (status?: string, active = true) => ({ projectScope: 'p', configured: true, activeProfileId: status && active ? 'profile-a' : undefined, profiles: status ? [profile('profile-a', status)] : [] });

function welcomeDom(): { doc: FakeDocument; parts: Record<string, FakeNode> } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  const parts: Record<string, FakeNode> = {};
  for (const [id, tag, hidden] of [['welcome-connect', 'div', true], ['welcome-connect-title', 'h2', false], ['welcome-connect-body', 'p', false], ['welcome-connect-reason', 'p', true], ['welcome-new-profile', 'button', false], ['welcome-choose-profile', 'button', true], ['welcome-open-folder', 'button', true], ['welcome-ready', 'div', true], ['input', 'TEXTAREA', false]] as const) {
    const node = doc.createElement(tag);
    node.id = id;
    node.hidden = hidden;
    parts[id] = node;
  }
  parts['welcome-connect'].append(parts['welcome-connect-title'], parts['welcome-connect-body'], parts['welcome-connect-reason'], parts['welcome-new-profile'], parts['welcome-choose-profile'], parts['welcome-open-folder']);
  welcome.append(parts['welcome-connect'], parts['welcome-ready']);
  doc.body.append(welcome, parts.input);
  return { doc, parts };
}

test('the welcome state follows the folder and the profile', () => {
  assert.equal(setup.welcomeState({ ...profileValue(), noWorkspace: true }), 'no-folder');
  assert.equal(setup.welcomeState(profileValue()), 'connect');
  assert.equal(setup.welcomeState(undefined), 'connect');
  assert.equal(setup.welcomeState(profileValue('invalid')), 'choose');
  assert.equal(setup.welcomeState(profileValue('pending')), 'choose');
  assert.equal(setup.welcomeState(profileValue('valid')), 'ready');
  // Saved profiles that all work, none selected: choose one; one of them needs checking: check its key.
  assert.equal(setup.welcomeState(profileValue('valid', false)), 'select');
  assert.equal(setup.welcomeState({ profiles: [profile('a', 'valid'), profile('b', 'invalid')] }), 'choose');
});

test('a saved cloud profile with a missing credential needs reconnection, while a validated keyless local profile remains ready', () => {
  const { doc, parts } = welcomeDom();
  const memory = {};
  for (const provider of ['near-ai', 'hybrid']) {
    const value = { ...profileValue('valid'), configured: false, profiles: [{ ...profile('profile-a', 'valid'), provider }] };
    const disconnected = setup.welcomeState(value);
    assert.equal(disconnected, 'choose');
    setup.applyWelcomeState(doc, disconnected, memory);
    assert.equal(parts['welcome-connect'].hidden, false);
    assert.equal(parts['welcome-choose-profile'].hidden, false);
    assert.equal(parts['welcome-ready'].hidden, true);
    setup.applyWelcomeState(doc, setup.welcomeState({ ...value, configured: true }), memory);
    assert.equal(parts['welcome-connect'].hidden, true);
    assert.equal(parts['welcome-ready'].hidden, false);
  }
  const local = { ...profileValue('valid'), configured: false, profiles: [{ ...profile('profile-a', 'valid'), provider: 'local' }] };
  assert.equal(setup.welcomeState(local), 'ready');
  assert.equal(setup.welcomeState({ ...local, profiles: [{ ...local.profiles[0], validation: { status: 'invalid' } }] }), 'choose');
});

test('without a working profile only the Connect panel shows, its words follow the state, and setup switches to the usual welcome', () => {
  const { doc, parts } = welcomeDom();
  const memory = {};
  const focus = setup.applyWelcomeState(doc, 'connect', memory);
  assert.equal(parts['welcome-connect'].hidden, false);
  assert.equal(parts['welcome-ready'].hidden, true, 'no Open-GSD cards and no team card');
  assert.equal(parts['welcome-choose-profile'].hidden, true);
  assert.equal(parts['welcome-connect-reason'].hidden, true);
  assert.equal(parts['welcome-connect-title'].textContent, 'Connect AI to start');
  assert.equal(focus, parts['welcome-new-profile'], 'focus goes to Set up a new profile the first time');
  // A saved profile that needs its key checked: Choose a profile, with that reason.
  assert.equal(setup.applyWelcomeState(doc, 'choose', memory), undefined, 'not focused again');
  assert.equal(parts['welcome-choose-profile'].hidden, false);
  assert.deepEqual([parts['welcome-connect-reason'].hidden, parts['welcome-connect-reason'].textContent], [false, 'Your saved profile needs its connection checked again.']);
  // Working profiles, none selected: a different reason.
  setup.applyWelcomeState(doc, 'select', memory);
  assert.equal(parts['welcome-choose-profile'].hidden, false);
  assert.equal(parts['welcome-connect-reason'].textContent, 'Choose which saved profile this project uses.');
  // After setup (profile-status refreshes): the usual welcome, with no reload.
  assert.equal(setup.applyWelcomeState(doc, 'ready', memory), undefined);
  assert.equal(parts['welcome-connect'].hidden, true);
  assert.equal(parts['welcome-ready'].hidden, false);
  for (const words of Object.values(setup.WELCOME)) for (const text of Object.values(words)) assert.doesNotMatch(text, /[—–]/, text);
});

test('with no folder open the panel asks to open one, and its button is the only action', () => {
  const { doc, parts } = welcomeDom();
  const focus = setup.applyWelcomeState(doc, 'no-folder', {});
  assert.equal(parts['welcome-connect-title'].textContent, 'Open a folder to start');
  assert.match(parts['welcome-connect-body'].textContent, /Open the folder you want to work on/);
  assert.deepEqual(['welcome-new-profile', 'welcome-choose-profile', 'welcome-open-folder'].map((id) => parts[id].hidden), [true, true, false]);
  assert.equal(focus, parts['welcome-open-folder']);
  // Once a folder is open (a new window), the usual Connect panel.
  setup.applyWelcomeState(doc, 'connect', { connectShown: true });
  assert.deepEqual(['welcome-new-profile', 'welcome-open-folder'].map((id) => parts[id].hidden), [false, true]);
  assert.equal(parts['welcome-connect-title'].textContent, 'Connect AI to start');
});

test('the Connect panel never takes focus from a text box, a list, or a window in the background', () => {
  const { doc, parts } = welcomeDom();
  doc.activeElement = parts.input;
  assert.equal(setup.applyWelcomeState(doc, 'connect', {}), undefined, 'the message box, even empty');
  parts.input.value = 'half a question';
  assert.equal(setup.applyWelcomeState(doc, 'connect', {}), undefined);
  doc.activeElement = doc.createElement('SELECT');
  assert.equal(setup.applyWelcomeState(doc, 'connect', {}), undefined, 'the model picker');
  doc.activeElement = undefined;
  doc.hasFocus = () => false;
  assert.equal(setup.applyWelcomeState(doc, 'connect', {}), undefined, 'the window is in the background');
  doc.hasFocus = () => true;
  assert.equal(setup.applyWelcomeState(doc, 'connect', {}), parts['welcome-new-profile']);
  assert.equal(setup.focusBusy(doc), false);
});

test('when the Connect panel goes away under the focus, focus moves to the message box', () => {
  const { doc, parts } = welcomeDom();
  const memory = {};
  setup.applyWelcomeState(doc, 'connect', memory);
  doc.activeElement = parts['welcome-new-profile'];
  assert.equal(setup.applyWelcomeState(doc, 'ready', memory), parts.input);
  // Focus elsewhere: nothing moves.
  setup.applyWelcomeState(doc, 'choose', memory);
  doc.activeElement = undefined;
  assert.equal(setup.applyWelcomeState(doc, 'ready', memory), undefined);
  // A button that hides under the focus (Choose a profile, when the state goes back to connect) hands it to the main one.
  setup.applyWelcomeState(doc, 'choose', memory);
  doc.activeElement = parts['welcome-choose-profile'];
  assert.equal(setup.applyWelcomeState(doc, 'connect', memory), parts['welcome-new-profile']);
});

test('the sidebar HTML has the Connect panel, hidden until the profile is known, and the chat wires it', () => {
  const panel = readFileSync(path.join(ROOT, 'src', 'services', 'panelView.ts'), 'utf8');
  assert.match(panel, /<div id="welcome-connect" role="region" aria-labelledby="welcome-connect-title" hidden>/);
  assert.match(panel, /<h2 id="welcome-connect-title">Connect AI to start<\/h2>/);
  assert.match(panel, /<button id="welcome-new-profile" class="text-button primary" type="button">Set up a new profile<\/button>/);
  assert.match(panel, /<button id="welcome-choose-profile" class="text-button" type="button" hidden>Choose a profile<\/button>/);
  assert.match(panel, /<p id="welcome-connect-reason" hidden><\/p>/);
  assert.match(panel, /<button id="welcome-open-folder" class="text-button primary" type="button" hidden>Open a folder<\/button>/);
  assert.match(panel, /<div id="welcome-ready" hidden>\s*<h2>AI for this project<\/h2>[\s\S]*class="suggestions"/);
  const welcome = panel.slice(panel.indexOf('<section id="welcome">'), panel.indexOf('</section>', panel.indexOf('<section id="welcome">')));
  assert.doesNotMatch(welcome, /style=|—/);
  const script = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /\$\('welcome-new-profile'\)\.addEventListener\('click', \(\) => post\(\{ type: 'new-profile' \}\)\)/);
  assert.match(script, /\$\('welcome-choose-profile'\)\.addEventListener\('click', \(\) => post\(\{ type: 'select-profile' \}\)\)/);
  assert.match(script, /\$\('welcome-open-folder'\)\.addEventListener\('click', \(\) => post\(\{ type: 'open-folder' \}\)\)/);
  assert.match(script, /const setupState = setupKit\.welcomeState\(value\)/);
  assert.match(script, /setupKit\.applyWelcomeState\(document, setupState, welcomeMemory\)/);
  // Without the helper the usual welcome shows, not a blank one.
  assert.match(script, /applyWelcomeState: \(\) => \{ const ready = \$\('welcome-ready'\); if \(ready\) ready\.hidden = false; \}/);
  // The sign-in notice uses the panel's words.
  assert.match(script, /textButton\('Set up a new profile', \(\) => post\(\{ type: 'new-profile' \}\), true\),\n\s*textButton\('Choose a profile', \(\) => post\(\{ type: 'select-profile' \}\)\)/);
  assert.match(script, /case 'setup-nudge': setupKit\.renderSetupNudge\(document, welcomeReady,/, 'the team card lives in the usual welcome');
  assert.deepEqual(parseChatWebviewMessage({ type: 'new-profile' }), { type: 'new-profile' });
  assert.equal(parseChatWebviewMessage({ type: 'new-profile', command: 'workbench.action.terminal.new' }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-folder' }), { type: 'open-folder' });
  assert.equal(parseChatWebviewMessage({ type: 'open-folder', path: '/etc' }), undefined);
});

test('the view\'s card messages are parsed strictly', () => {
  for (const action of ['team', 'staff', 'later', 'menu'] as const) assert.deepEqual(parseChatWebviewMessage({ type: 'setup-nudge', action }), { type: 'setup-nudge', action });
  assert.equal(parseChatWebviewMessage({ type: 'setup-nudge', action: 'workbench.action.terminal.new' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'setup-nudge' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'setup-nudge', action: 'team', command: 'x' }), undefined);
});

// ---- the host side: the real chat handler against a VS Code stand-in ----

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const executed: unknown[][] = [];
const watchers: Array<{ pattern: { base: { fsPath: string }; pattern: string }; created: Array<() => void>; deleted: Array<() => void>; disposed: boolean }> = [];
const vscodeStub = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  QuickPickItemKind: { Separator: -1 },
  ViewColumn: { Active: -1 },
  RelativePattern: class { public constructor(public readonly base: { fsPath: string }, public readonly pattern: string) {} },
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    name: 'demo',
    getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback, has: () => false, inspect: () => undefined, update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    createFileSystemWatcher: (pattern: { base: { fsPath: string }; pattern: string }) => {
      const watcher = { pattern, created: [] as Array<() => void>, deleted: [] as Array<() => void>, disposed: false };
      watchers.push(watcher);
      return { onDidCreate: (listener: () => void) => { watcher.created.push(listener); return { dispose() {} }; }, onDidDelete: (listener: () => void) => { watcher.deleted.push(listener); return { dispose() {} }; }, dispose: () => { watcher.disposed = true; } };
    }
  },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    activeTextEditor: undefined
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (...args: unknown[]) => { executed.push(args); }
  },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts), path: path.join(base.fsPath, ...parts), toString: () => path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};
function load<T>(id: string): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try { return require(id) as T; } finally { nodeModule._load = originalLoad; }
}

test('the host shows the card for a working profile without a team, hides it on "Not now" for this project, and when a team is saved', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-nudge-'));
  const auth = new AuthService(new MemorySecrets());
  await new ProfileStore(root, auth, { validator: async () => undefined }).configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const state = new Map<string, unknown>();
  const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: path.join(tmpdir(), `near-ai-nudge-${process.pid}`) }, extensionUri: { fsPath: ROOT, path: ROOT }, secrets: new MemorySecrets(), workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } }, globalState: { get: () => undefined, update: async () => undefined } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/models') ? Response.json({ data: [{ id: 'z-ai/glm-5.3' }] }) : String(input).endsWith('/model/list') ? Response.json({ models: [] }) : new Response('{}', { status: 404 })) as typeof fetch;
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  let dispose: (() => void) | undefined;
  const sidebar = { webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } }, onDidDispose: (listener: () => void) => { dispose = listener; return { dispose() {} }; } };
  const nudge = () => posted.filter((message) => message.type === 'setup-nudge').at(-1)?.show;
  try {
    const { attachChatToView } = load<typeof import('../services/chat')>('../services/chat');
    await attachChatToView(context as never, auth, sidebar as never, '<html></html>', testGateHost());
    assert.equal(nudge(), true, 'shown when the chat opens');
    // The buttons run the host's commands, never a command the view names.
    await receive!({ type: 'setup-nudge', action: 'team' });
    await receive!({ type: 'setup-nudge', action: 'menu' });
    await receive!({ type: 'new-profile' });
    await receive!({ type: 'open-folder' });
    assert.deepEqual(executed.splice(0), [['nearAi.setupProjectTeam'], ['nearAi.projectSetup'], ['nearAi.newProfile'], ['workbench.action.files.openFolder']]);
    // A team saved by Team Studio: the watcher sees the file and the card goes away.
    const [watcher] = watchers;
    assert.equal(watcher.pattern.base.fsPath, root);
    assert.equal(watcher.pattern.pattern, '{.planning,.planning/.near-ai,.planning/.near-ai/team.md,.planning/.near-ai/project.json}');
    await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
    await writeFile(path.join(root, '.planning', '.near-ai', 'team.md'), '# Team\n');
    posted.length = 0;
    watcher.created.forEach((listener) => listener());
    for (let wait = 0; wait < 50 && nudge() === undefined; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(nudge(), false);
    // The team file deleted: the watcher reports it, and the card comes back without a refresh.
    // (Deleting the whole .planning folder also takes the profile with it, so the card stays hidden then.)
    const { rm } = await import('node:fs/promises');
    await rm(path.join(root, '.planning', '.near-ai', 'team.md'));
    posted.length = 0;
    watcher.deleted.forEach((listener) => listener());
    for (let wait = 0; wait < 50 && nudge() === undefined; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(nudge(), true);
    // A project type alone (project.json) is not a team: the card stays.
    await writeFile(path.join(root, '.planning', '.near-ai', 'project.json'), '{}\n');
    await receive!({ type: 'refresh-status' });
    assert.equal(nudge(), true);
    // "Not now" hides it for this project, and a refresh keeps it hidden.
    await receive!({ type: 'setup-nudge', action: 'later' });
    assert.equal(state.get(SETUP_NUDGE_DISMISSED_KEY), true);
    assert.equal(nudge(), false);
    await receive!({ type: 'refresh-status' });
    assert.equal(nudge(), false);
    assert.deepEqual(executed, []);
    dispose!();
    assert.equal(watcher.disposed, true, 'the watcher stops with the view');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the host does not show the card before a profile works', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-nudge-none-'));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const sidebar = { webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }) };
  const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: path.join(tmpdir(), `near-ai-nudge-none-${process.pid}`) }, extensionUri: { fsPath: ROOT, path: ROOT }, secrets: new MemorySecrets(), workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } };
  const { attachChatToView } = load<typeof import('../services/chat')>('../services/chat');
  await attachChatToView(context as never, new AuthService(new MemorySecrets()), sidebar as never, '<html></html>', testGateHost());
  await receive!({ type: 'refresh-status' });
  const shown = posted.filter((message) => message.type === 'setup-nudge').map((message) => message.show);
  assert.ok(shown.length >= 2);
  assert.ok(shown.every((show) => show === false));
  const status = () => posted.filter((message) => message.type === 'profile-status').at(-1)?.value as { noWorkspace?: boolean } | undefined;
  assert.equal(status()?.noWorkspace, undefined, 'a folder is open');
  // No folder open: the profile status says so, and the view asks to open one.
  vscodeStub.workspace.workspaceFolders = [];
  try {
    await receive!({ type: 'refresh-status' });
    assert.equal(status()?.noWorkspace, true);
    assert.equal(setup.welcomeState(status()), 'no-folder');
  } finally {
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  }
});

test('a staff team set up while the chat is open replaces the "no team yet" card at once, with no file watcher event; "Set up a staff team" runs the setup (D-48 of 0.4.35)', async () => {
  // code-server did not deliver the watcher's event, so the open chat kept "no team yet" after the J2 team was set up. The setup now tells the chat.
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-nudge-staff-'));
  const previousTeams = process.env.NEAR_AI_TEAMS_DIR;
  process.env.NEAR_AI_TEAMS_DIR = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-nudge-teams-'));
  const auth = new AuthService(new MemorySecrets());
  await new ProfileStore(root, auth, { validator: async () => undefined }).configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: path.join(tmpdir(), `near-ai-nudge-staff-${process.pid}`) }, extensionUri: { fsPath: ROOT, path: ROOT }, secrets: new MemorySecrets(), workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/models') ? Response.json({ data: [{ id: 'z-ai/glm-5.3' }] }) : String(input).endsWith('/model/list') ? Response.json({ models: [] }) : new Response('{}', { status: 404 })) as typeof fetch;
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  let dispose: (() => void) | undefined;
  let shown: (() => void) | undefined;
  const sidebar = { visible: true, webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } }, onDidDispose: (listener: () => void) => { dispose = listener; return { dispose() {} }; }, onDidChangeVisibility: (listener: () => void) => { shown = listener; return { dispose() { shown = undefined; } }; } };
  const nudge = () => posted.filter((message) => message.type === 'setup-nudge').at(-1)?.show;
  const staffCard = () => posted.filter((message) => message.type === 'staff-teams').at(-1)?.model as { sections: Array<{ section: string; state: string; team?: string }> } | null | undefined;
  const until = async (done: () => boolean) => { for (let wait = 0; wait < 200 && !done(); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  try {
    const { attachChatToView } = load<typeof import('../services/chat')>('../services/chat');
    await attachChatToView(context as never, auth, sidebar as never, '<html></html>', testGateHost());
    assert.equal(nudge(), true, '"no team yet" when the chat opens');
    assert.equal(staffCard(), null, 'no Staff teams card outside a staff project');
    // The card's "Set up a staff team" runs the setup command (the host's own command, nothing the view names).
    executed.length = 0;
    await receive!({ type: 'setup-nudge', action: 'staff' });
    assert.deepEqual(executed.splice(0), [['nearAi.setUpStaffTeam']]);
    // What the command writes for J2, US Joint, operational, contingency. No watcher listener is called: only the setup's own notice.
    posted.length = 0;
    const plan = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options: { settings: { ...defaultStaffSettings(), profile: 'us-joint', level: 'operational', planningType: 'contingency' }, locality: 'local' } });
    await applyStaffSetup(root, new TeamLibrary(teamLibraryDir(homeFolder())), plan);
    await until(() => Boolean(staffCard()) && nudge() === false);
    const j2 = staffCard()?.sections.find((entry) => entry.section === 'j2');
    assert.deepEqual([j2?.state, j2?.team], ['ready', 'j2-us-joint-operational']);
    assert.equal(nudge(), false, 'the "no team yet" card goes');
    // Shown again after being hidden: the cards are worked out again, so a message lost while hidden never leaves an old card.
    posted.length = 0;
    shown!();
    await until(() => Boolean(staffCard()));
    assert.equal(staffCard()?.sections.find((entry) => entry.section === 'j2')?.state, 'ready');
    // A setup in another folder does not concern this chat.
    posted.length = 0;
    const other = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-nudge-other-'));
    const { staffTeamsChanged } = await import('../services/staffSetup');
    staffTeamsChanged(other);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(posted.filter((message) => message.type === 'staff-teams'), []);
    dispose!();
    assert.equal(shown, undefined, 'stops listening with the view');
    staffTeamsChanged(root);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(posted.filter((message) => message.type === 'staff-teams'), [], 'nothing posted after the view is gone');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTeams === undefined) delete process.env.NEAR_AI_TEAMS_DIR; else process.env.NEAR_AI_TEAMS_DIR = previousTeams;
  }
});

test('a staff project whose teams cannot be read shows the Staff teams card with the reason and logs it, never the "no team yet" card in silence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-nudge-unread-'));
  const auth = new AuthService(new MemorySecrets());
  await new ProfileStore(root, auth, { validator: async () => undefined }).configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, '.planning', '.near-ai', 'project.json'), JSON.stringify({ staff: { profile: 'us-joint', level: 'operational', teams: { j2: 'Not A Name' } } }));
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: path.join(tmpdir(), `near-ai-nudge-unread-${process.pid}`) }, extensionUri: { fsPath: ROOT, path: ROOT }, secrets: new MemorySecrets(), workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/models') ? Response.json({ data: [{ id: 'z-ai/glm-5.3' }] }) : new Response('{}', { status: 404 })) as typeof fetch;
  const logged: string[] = [];
  setNearAiDiagnostics((line) => logged.push(line));
  const posted: Array<Record<string, unknown>> = [];
  const sidebar = { webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: () => ({ dispose() {} }) }, onDidDispose: () => ({ dispose() {} }) };
  try {
    const { attachChatToView } = load<typeof import('../services/chat')>('../services/chat');
    await attachChatToView(context as never, auth, sidebar as never, '<html></html>', testGateHost());
    const card = posted.filter((message) => message.type === 'staff-teams').at(-1)?.model as { staff: boolean; problem?: string } | null;
    assert.equal(card?.staff, true);
    assert.match(card?.problem ?? '', /staff settings in \.planning\/\.near-ai\/project\.json are not valid/);
    assert.equal(posted.filter((message) => message.type === 'setup-nudge').at(-1)?.show, false, 'no "no team yet" card in a staff project');
    assert.ok(logged.some((line) => /^Staff teams: The staff settings/.test(line)), JSON.stringify(logged));
  } finally {
    setNearAiDiagnostics(undefined);
    globalThis.fetch = originalFetch;
  }
});
