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

const ROOT = path.join(__dirname, '..', '..');

// ---- the card in the view, against a small DOM stand-in ----

class FakeNode {
  public children: FakeNode[] = [];
  public parent?: FakeNode;
  public className = '';
  public id = '';
  public type = '';
  public hidden = false;
  public value = '';
  public textContent = '';
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<() => void>>();
  public constructor(public readonly tagName: string, private readonly doc: FakeDocument) {}
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
  public append(...nodes: FakeNode[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  public prepend(...nodes: FakeNode[]): void { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  public remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined; }
  public get attached(): boolean { let node: FakeNode | undefined = this; while (node?.parent) node = node.parent; return node === this.doc.body; }
  public contains(node: FakeNode | undefined): boolean { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  public find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { for (const child of this.children) { if (predicate(child)) return child; const found = child.find(predicate); if (found) return found; } return undefined; }
  public all(predicate: (node: FakeNode) => boolean): FakeNode[] { return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); }
}
class FakeDocument {
  public readonly body: FakeNode = new FakeNode('body', this);
  public activeElement?: FakeNode;
  public createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
  public getElementById(id: string): FakeNode | undefined { return this.body.find((node) => node.id === id); }
}

interface SetupKit {
  renderSetupNudge(doc: FakeDocument, container: FakeNode, show: boolean, post: (message: unknown) => void, afterDismiss?: () => void): FakeNode | undefined;
  welcomeState(value: unknown): 'ready' | 'choose' | 'connect';
  applyWelcomeState(doc: FakeDocument, state: string, memory: Record<string, unknown>): FakeNode | undefined;
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
  const [team, later, menu] = card.all((node) => node.tagName === 'button');
  team.click();
  menu.click();
  assert.deepEqual(posts, [{ type: 'setup-nudge', action: 'team' }, { type: 'setup-nudge', action: 'menu' }]);
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
  const css = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.css'), 'utf8');
  const rules = css.split('\n').filter((line) => line.includes('setup-nudge')).join('\n');
  assert.match(rules, /\.setup-nudge \{/);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'no fixed colours');
  assert.match(rules, /var\(--vscode-/);
});

// ---- the welcome before a working profile ----

const profileValue = (status?: string, active = true) => ({ projectScope: 'p', configured: true, activeProfileId: status && active ? 'profile-a' : undefined, profiles: status ? [{ profileId: 'profile-a', displayName: 'Demo', validation: { status } }] : [] });

function welcomeDom(): { doc: FakeDocument; parts: Record<string, FakeNode> } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  const parts: Record<string, FakeNode> = {};
  for (const [id, tag, hidden] of [['welcome-connect', 'div', true], ['welcome-connect-reason', 'p', true], ['welcome-new-profile', 'button', false], ['welcome-choose-profile', 'button', true], ['welcome-ready', 'div', true]] as const) {
    const node = doc.createElement(tag);
    node.id = id;
    node.hidden = hidden;
    parts[id] = node;
  }
  parts['welcome-connect'].append(parts['welcome-connect-reason'], parts['welcome-new-profile'], parts['welcome-choose-profile']);
  welcome.append(parts['welcome-connect'], parts['welcome-ready']);
  doc.body.append(welcome);
  return { doc, parts };
}

test('the welcome state follows the profile: connect with none, choose when none works, ready with a working one', () => {
  assert.equal(setup.welcomeState(profileValue()), 'connect');
  assert.equal(setup.welcomeState(undefined), 'connect');
  assert.equal(setup.welcomeState(profileValue('invalid')), 'choose');
  assert.equal(setup.welcomeState(profileValue('pending')), 'choose');
  assert.equal(setup.welcomeState(profileValue('valid', false)), 'choose', 'a working profile that is not selected');
  assert.equal(setup.welcomeState(profileValue('valid')), 'ready');
});

test('without a working profile only the Connect panel shows, and setup switches to the usual welcome', () => {
  const { doc, parts } = welcomeDom();
  const memory = {};
  const focus = setup.applyWelcomeState(doc, 'connect', memory);
  assert.equal(parts['welcome-connect'].hidden, false);
  assert.equal(parts['welcome-ready'].hidden, true, 'no Open-GSD cards and no team card');
  assert.equal(parts['welcome-choose-profile'].hidden, true);
  assert.equal(parts['welcome-connect-reason'].hidden, true);
  assert.equal(focus, parts['welcome-new-profile'], 'focus goes to Set up a new profile the first time');
  // A saved profile that needs its key checked: Choose a profile, with the reason.
  assert.equal(setup.applyWelcomeState(doc, 'choose', memory), undefined, 'not focused again');
  assert.equal(parts['welcome-choose-profile'].hidden, false);
  assert.equal(parts['welcome-connect-reason'].hidden, false);
  // After setup (profile-status refreshes): the usual welcome, with no reload.
  assert.equal(setup.applyWelcomeState(doc, 'ready', memory), undefined);
  assert.equal(parts['welcome-connect'].hidden, true);
  assert.equal(parts['welcome-ready'].hidden, false);
});

test('the Connect panel does not take focus from a message being typed', () => {
  const { doc } = welcomeDom();
  const input = doc.createElement('TEXTAREA');
  input.value = 'half a question';
  doc.activeElement = input;
  assert.equal(setup.applyWelcomeState(doc, 'connect', {}), undefined);
  input.value = '';
  assert.ok(setup.applyWelcomeState(doc, 'connect', {}), 'an empty message box is not typing');
});

test('the sidebar HTML has the Connect panel, hidden until the profile is known, and the chat wires it', () => {
  const panel = readFileSync(path.join(ROOT, 'src', 'services', 'panelView.ts'), 'utf8');
  assert.match(panel, /<div id="welcome-connect" role="region" aria-labelledby="welcome-connect-title" hidden>/);
  assert.match(panel, /<h2 id="welcome-connect-title">Connect NEAR AI to start<\/h2>/);
  assert.match(panel, /<button id="welcome-new-profile" class="text-button primary" type="button">Set up a new profile<\/button>/);
  assert.match(panel, /<button id="welcome-choose-profile" class="text-button" type="button" hidden>Choose a profile<\/button>/);
  assert.match(panel, /<p id="welcome-connect-reason" hidden>Your saved profile needs its key checked again\.<\/p>/);
  assert.match(panel, /<div id="welcome-ready" hidden>\s*<h2>Private AI for this project<\/h2>[\s\S]*class="suggestions"/);
  const welcome = panel.slice(panel.indexOf('<section id="welcome">'), panel.indexOf('</section>', panel.indexOf('<section id="welcome">')));
  assert.doesNotMatch(welcome, /style=|—/);
  const script = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /\$\('welcome-new-profile'\)\.addEventListener\('click', \(\) => post\(\{ type: 'new-profile' \}\)\)/);
  assert.match(script, /\$\('welcome-choose-profile'\)\.addEventListener\('click', \(\) => post\(\{ type: 'select-profile' \}\)\)/);
  assert.match(script, /setupKit\.applyWelcomeState\(document, setupKit\.welcomeState\(value\), welcomeMemory\)/);
  assert.match(script, /case 'setup-nudge': setupKit\.renderSetupNudge\(document, welcomeReady,/, 'the team card lives in the usual welcome');
  assert.deepEqual(parseChatWebviewMessage({ type: 'new-profile' }), { type: 'new-profile' });
  assert.equal(parseChatWebviewMessage({ type: 'new-profile', command: 'workbench.action.terminal.new' }), undefined);
});

test('the view\'s card messages are parsed strictly', () => {
  for (const action of ['team', 'later', 'menu'] as const) assert.deepEqual(parseChatWebviewMessage({ type: 'setup-nudge', action }), { type: 'setup-nudge', action });
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
    await attachChatToView(context as never, auth, sidebar as never, '<html></html>');
    assert.equal(nudge(), true, 'shown when the chat opens');
    // The buttons run the host's commands, never a command the view names.
    await receive!({ type: 'setup-nudge', action: 'team' });
    await receive!({ type: 'setup-nudge', action: 'menu' });
    await receive!({ type: 'new-profile' });
    assert.deepEqual(executed.splice(0), [['nearAi.setupProjectTeam'], ['nearAi.projectSetup'], ['nearAi.newProfile']]);
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
  await attachChatToView(context as never, new AuthService(new MemorySecrets()), sidebar as never, '<html></html>');
  await receive!({ type: 'refresh-status' });
  const shown = posted.filter((message) => message.type === 'setup-nudge').map((message) => message.show);
  assert.ok(shown.length >= 2);
  assert.ok(shown.every((show) => show === false));
});
