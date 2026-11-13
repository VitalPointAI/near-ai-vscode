// The sync control in the chat panel's bar (D-16, SYNC-04, SYNC-05, SYNC-09): present from the moment the panel opens, one click into the turn-on flow, the five
// states in plain words, errors on the control, keyboard and theme support, and the dismissible "Turn on sync" invitation. The view code runs against a
// small DOM stand-in (helpers/fakeDom.ts); the host side is pure and runs on plain node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { shouldShowSyncPrompt, SYNC_PROMPT_TEXT, syncControlModel, syncStatusMessage, type SyncControlModel } from '../domain/state/syncStatus';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { syncPanelMessage, SYNC_PROMPT_DISMISSED_KEY } from '../services/syncPanel';
import { pickupCardModel } from '../services/pickupCard';
import type { PickupModel } from '../domain/state/pickup';
import type { MementoLike } from '../services/stateHome';
import type { SyncStatus } from '../services/syncFlows';
import { FakeDocument, FakeNode } from './helpers/fakeDom';
import { tempProject } from './helpers/stateFixtures';

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');

interface SyncKit {
  renderSyncControl(doc: FakeDocument, button: FakeNode, model: SyncControlModel, post: (message: unknown) => void): FakeNode;
  renderSyncPrompt(doc: FakeDocument, container: FakeNode, post: (message: unknown) => void, wanted: boolean): FakeNode | undefined;
  buildSyncPrompt(doc: FakeDocument, post: (message: unknown) => void, id?: string): FakeNode;
  TEXT: Record<string, string>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kit = require(path.join(ROOT, 'media', 'chat', 'syncControl.js')) as SyncKit;

const NOW = new Date(2026, 10, 13, 15, 30).getTime();
const AT = new Date(2026, 10, 13, 9, 5).toISOString();

/** The bar as panelView.ts lays it out: the profile chip, then the sync chip and its live region. */
function bar(): { doc: FakeDocument; button: FakeNode; live: FakeNode } {
  const doc = new FakeDocument();
  const row = doc.createElement('div');
  const profile = doc.createElement('button');
  profile.id = 'profile';
  const button = doc.createElement('button');
  button.id = 'sync';
  button.className = 'chip';
  const live = doc.createElement('span');
  live.id = 'sync-live';
  row.append(profile, button, live);
  doc.body.append(row);
  return { doc, button, live };
}

const STATUSES: Array<[string, SyncStatus, string, string]> = [
  ['off', { state: 'off' }, 'Sync off · Turn on', 'turn-on'],
  ['syncing', { state: 'syncing', reason: 'open' }, 'Syncing…', 'none'],
  ['synced', { state: 'synced', at: AT }, 'Synced · 09:05', 'sync-now'],
  ['attention', { state: 'attention', message: 'Couldn\'t reach GitHub, will retry.' }, 'Needs attention', 'show-details'],
  ['no-home', { state: 'no-home', message: 'This project has no online home yet.' }, 'No online home · Set up', 'set-up-home']
];

test('tracer: the model for "off" says "Sync off · Turn on", turns sync on and has an accessible name that starts with the feature', () => {
  const model = syncControlModel({ state: 'off' }, NOW);
  assert.equal(model.label, 'Sync off · Turn on');
  assert.equal(model.action, 'turn-on');
  assert.match(model.ariaLabel, /^Project sync:/);
  assert.equal(model.busy, false);
});

test('tracer: the button gets its text, name and tooltip, and a click posts exactly the turn-on request', () => {
  const { doc, button } = bar();
  const posts: unknown[] = [];
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'off' }, NOW), (message) => posts.push(message));
  assert.equal(button.textContent, 'Sync off · Turn on');
  assert.match(button.attributes.get('aria-label') ?? '', /^Project sync: off/);
  assert.ok((button.attributes.get('title') ?? '').length > 0);
  assert.equal(button.attributes.get('data-state'), 'off');
  button.click();
  assert.deepEqual(posts, [{ type: 'sync-control', action: 'turn-on' }]);
});

test('tracer: the bar markup has the sync chip right after the profile chip and loads syncControl.js before chat.js', () => {
  const panel = read('src', 'services', 'panelView.ts');
  assert.equal((panel.match(/id="sync"/g) ?? []).length, 1);
  const profileAt = panel.indexOf('id="profile"');
  const syncAt = panel.indexOf('id="sync"');
  const modelAt = panel.indexOf('id="model"');
  assert.ok(profileAt > 0 && profileAt < syncAt && syncAt < modelAt, 'next to the profile control, in the bar');
  const tag = panel.slice(panel.lastIndexOf('<button', syncAt), panel.indexOf('</button>', syncAt));
  assert.match(tag, /class="chip"/);
  assert.match(tag, /type="button"/);
  assert.match(tag, />Sync off · Turn on$/, 'shows before the first message arrives');
  assert.ok(panel.indexOf("asset('syncControl.js')") > 0);
  assert.ok(panel.indexOf("asset('syncControl.js')") < panel.indexOf("asset('chat.js')"));
  assert.match(panel, /id="sync-live"[^>]*aria-live="polite"/);
});

test('tracer: the bridge accepts the five requests and rejects unknown actions and extra keys', () => {
  for (const action of ['turn-on', 'set-up-home', 'show-details', 'sync-now', 'dismiss-prompt']) {
    assert.deepEqual(parseChatWebviewMessage({ type: 'sync-control', action }), { type: 'sync-control', action });
  }
  assert.equal(parseChatWebviewMessage({ type: 'sync-control', action: 'turn-off' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'sync-control', action: 'turn-on', extra: 1 }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'sync-control' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'sync-control', action: 7 }), undefined);
});

test('tracer: the host builds the panel-open message from the current status, and a project with sync off gets the turn-on control and the invitation', () => {
  const message = syncPanelMessage({ state: 'off' }, undefined, NOW);
  assert.equal(message.type, 'sync-status');
  assert.equal(message.model.label, 'Sync off · Turn on');
  assert.equal(message.prompt, true);
  assert.deepEqual(syncStatusMessage({ state: 'off' }, { now: NOW, dismissed: false }), message);
  const host = read('src', 'services', 'chat.ts');
  assert.match(host, /onSyncStatus\(/);
  assert.match(host, /currentSyncStatus\(/);
  assert.match(host, /'nearAi\.sync\.turnOn'/);
  assert.match(host, /'nearAi\.sync\.onlineHome'/);
  assert.match(host, /'nearAi\.sync\.now'/);
});

// ---- Task 2: all five states, live updates, errors on the control, keyboard and themes ----

test('every status shows its exact label, a name that says the state, and posts the matching action (none while syncing)', () => {
  for (const [name, status, label, action] of STATUSES) {
    const { doc, button } = bar();
    const posts: unknown[] = [];
    const model = syncControlModel(status, NOW);
    kit.renderSyncControl(doc, button, model, (message) => posts.push(message));
    assert.equal(button.textContent, label, name);
    assert.equal(model.action, action, name);
    assert.match(button.attributes.get('aria-label') ?? '', /^Project sync/, name);
    assert.ok((button.attributes.get('aria-label') ?? '').toLowerCase().includes(name === 'no-home' ? 'no online home' : name === 'attention' ? 'needs attention' : name === 'synced' ? 'synced' : name === 'syncing' ? 'syncing' : 'off'), `${name}: the name includes the state`);
    button.click();
    assert.deepEqual(posts, action === 'none' ? [] : [{ type: 'sync-control', action }], name);
  }
});

test('"Synced" shows the time of the last sync, today as the clock and another day with its date', () => {
  assert.equal(syncControlModel({ state: 'synced', at: AT }, NOW).label, 'Synced · 09:05');
  const yesterday = new Date(2026, 10, 12, 23, 59).toISOString();
  assert.equal(syncControlModel({ state: 'synced', at: yesterday }, NOW).label, 'Synced · Nov 12, 23:59');
  assert.equal(syncControlModel({ state: 'synced' }, NOW).label, 'Synced');
  assert.equal(syncControlModel({ state: 'synced', at: 'not a time' }, NOW).label, 'Synced');
});

test('a problem is shown on the control in plain words, in the name and the tooltip, not only in a log', () => {
  const model = syncControlModel({ state: 'attention', message: 'Couldn\'t reach GitHub, will retry.' }, NOW);
  assert.equal(model.title, 'Couldn\'t reach GitHub, will retry.');
  assert.match(model.ariaLabel, /Couldn't reach GitHub, will retry\./);
  const signIn = syncControlModel({ state: 'attention', message: 'Sync needs you to sign in. Choose Sync Project Now.' }, NOW);
  assert.match(signIn.title, /Choose Sync Project Now\./);
  assert.equal(syncControlModel({ state: 'attention' }, NOW).title.length > 0, true, 'a problem with no sentence still says something');
});

test('a status change re-renders the same button (no second control), and the live region says the new state once', () => {
  const { doc, button, live } = bar();
  const posts: unknown[] = [];
  const post = (message: unknown): number => posts.push(message);
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'off' }, NOW), post);
  assert.equal(live.textContent, '', 'the first render says nothing');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'syncing', reason: 'manual' }, NOW), post);
  assert.equal(live.textContent, 'Project sync: Syncing…');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), post);
  assert.equal(live.textContent, 'Project sync: Synced · 09:05');
  live.textContent = '';
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), post);
  assert.equal(live.textContent, '', 'the same state again is not announced again');
  assert.equal(doc.body.all((node) => node.id === 'sync').length, 1, 'one control');
  button.click();
  assert.deepEqual(posts, [{ type: 'sync-control', action: 'sync-now' }], 'one listener, whatever the number of renders');
});

test('a message with a password or token in it is redacted before it reaches the control', () => {
  const message = syncPanelMessage({ state: 'attention', message: 'Failed for https://user:pw@github.com/x/y.git' }, undefined, NOW);
  assert.doesNotMatch(JSON.stringify(message), /user:pw/);
  assert.doesNotMatch(JSON.stringify(message), /pw@/);
  assert.equal(message.model.label, 'Needs attention');
  // Built at run time so this file holds no token-shaped literal for the secret scan to find.
  const fakeToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
  const token = syncPanelMessage({ state: 'attention', message: `Rejected token ${fakeToken}` }, undefined, NOW);
  assert.ok(!JSON.stringify(token).includes(fakeToken), 'the token never reaches the control');
  assert.ok(!JSON.stringify(token).includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'no part of the token reaches the control');
});

test('the control never leaves the keyboard: aria-disabled and aria-busy while syncing, never disabled, never a negative tab index', () => {
  const { doc, button } = bar();
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'syncing', reason: 'open' }, NOW), () => undefined);
  assert.equal(button.attributes.get('aria-busy'), 'true');
  assert.equal(button.attributes.get('aria-disabled'), 'true');
  assert.equal((button as unknown as { disabled?: boolean }).disabled, undefined);
  assert.equal(button.attributes.get('tabindex'), undefined);
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), () => undefined);
  assert.equal(button.attributes.get('aria-busy'), 'false');
  assert.equal(button.attributes.get('aria-disabled'), 'false');
  const source = read('media', 'chat', 'syncControl.js');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, 'words are set with textContent only');
  assert.doesNotMatch(source, /tabIndex\s*=\s*-1|\.disabled\s*=/);
});

test('the sync chip is styled by state with theme variables only, with a visible border in high contrast and no hard-coded colour', () => {
  const css = read('media', 'chat', 'chat.css');
  const rules = css.split('\n').filter((line) => line.includes('#sync'));
  assert.ok(rules.length >= 2, 'rules for the chip');
  for (const state of ['off', 'syncing', 'synced', 'attention', 'no-home']) {
    assert.ok(rules.some((line) => line.includes(`data-state="${state}"`)) || state === 'off' || state === 'synced', `${state} has a look (or inherits the chip's)`);
  }
  assert.ok(rules.some((line) => line.includes('--vscode-errorForeground') || line.includes('--vscode-inputValidation-warningBorder')), 'attention stands out');
  assert.ok(rules.some((line) => line.includes('--vscode-focusBorder')), 'a visible focus');
  assert.ok(css.includes('vscode-high-contrast'), 'a high-contrast rule');
  assert.ok(rules.some((line) => line.includes('vscode-high-contrast') && line.includes('--vscode-contrastBorder')), 'a border in high contrast');
  for (const line of rules) assert.doesNotMatch(line, /#[0-9a-fA-F]{3,8}\b(?!\w)|rgba?\(|hsla?\(/, `no hard-coded colour: ${line}`);
});

interface PickupKit {
  renderPickupCard(doc: FakeDocument, container: FakeNode, model: PickupModel | undefined, post: (message: unknown) => void, afterDismiss?: () => void): FakeNode | undefined;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pickup = require(path.join(ROOT, 'media', 'chat', 'pickup.js')) as PickupKit;

class Memory implements MementoLike {
  public readonly values = new Map<string, unknown>();
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
}

const WRITER = 'aaaaaaaa1111.hosta00001';
const deps = (state: Memory, syncStatus?: SyncStatus) => ({ workspaceState: state, writer: WRITER, threads: { index: () => Promise.resolve([]) }, ...(syncStatus ? { syncStatus } : {}) });

function welcomeWithCard(model: Partial<PickupModel>): { doc: FakeDocument; welcome: FakeNode; card: FakeNode | undefined; posts: unknown[] } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  doc.body.append(welcome);
  const posts: unknown[] = [];
  const card = pickup.renderPickupCard(doc, welcome, { show: false, pointerAt: '', ...model }, (message) => posts.push(message));
  return { doc, welcome, card, posts };
}

test('while the pull on open runs the card says "Checking for updates…", and the chat is not blocked; it is worked out again when the status leaves syncing', async () => {
  const root = await tempProject();
  const state = new Memory();
  const checking = await pickupCardModel(deps(state, { state: 'syncing', reason: 'open' }), root);
  assert.equal(checking.checking, true);
  const { card, welcome, doc } = welcomeWithCard(checking);
  assert.ok(card, 'the card shows although there is nothing to pick up yet');
  assert.ok(card!.all((node) => node.textContent === 'Checking for updates…').length === 1);
  assert.equal(card!.all((node) => node.tagName === 'button').length, 1, 'only "Not now": nothing to open yet');
  // A later render with the finished model replaces it: no checking line, no card when there is nothing to show.
  const synced = await pickupCardModel(deps(state, { state: 'synced', at: AT }), root);
  assert.equal(synced.checking, undefined);
  assert.equal(pickup.renderPickupCard(doc, welcome, synced, () => undefined), undefined, 'the card is gone when there is nothing to pick up');
  assert.equal(doc.getElementById('pickup-card'), undefined);
  const manual = await pickupCardModel(deps(state, { state: 'syncing', reason: 'manual' }), root);
  assert.equal(manual.checking, undefined, 'only the pull on open is "Checking for updates…"');
  assert.equal((await pickupCardModel(deps(state), root)).checking, undefined, 'no sync status, no word about sync');
  for (const source of ['composer', 'send', 'input']) assert.doesNotMatch(read('media', 'chat', 'pickup.js'), new RegExp(`${source}\\.disabled`), 'the chat stays usable');
});

test('the card model carries the invitation before sync is on, never once it is on, and never after it was dismissed for this project', async () => {
  const root = await tempProject();
  const state = new Memory();
  assert.equal((await pickupCardModel(deps(state, { state: 'off' }), root)).syncPrompt, true);
  for (const status of STATUSES.map((entry) => entry[1]).filter((entry) => entry.state !== 'off')) {
    assert.equal((await pickupCardModel(deps(state, status), root)).syncPrompt, undefined, status.state);
  }
  await state.update(SYNC_PROMPT_DISMISSED_KEY, true);
  assert.equal((await pickupCardModel(deps(state, { state: 'off' }), root)).syncPrompt, undefined, 'never again once dismissed');
  assert.equal(syncPanelMessage({ state: 'off' }, state, NOW).prompt, false, 'the first-run invitation follows the same flag');
});

test('a pick-up card with the invitation has the line, a Turn on sync button and a dismiss button, and without it neither', () => {
  const { card, posts } = welcomeWithCard({ show: true, pointerAt: '2026-11-13T10:05:00.000Z', lastChat: { id: 'conv-abc123def', title: 'Fix it', at: '2026-11-13T10:00:00.000Z' }, syncPrompt: true });
  assert.ok(card!.all((node) => node.textContent === 'Keep this project on your other machines').length === 1);
  const turnOn = card!.all((node) => node.tagName === 'button' && node.textContent === 'Turn on sync')[0];
  const dismiss = card!.all((node) => node.tagName === 'button' && node.textContent === SYNC_PROMPT_TEXT.dismiss)[0];
  assert.ok(turnOn && dismiss);
  turnOn.click();
  dismiss.click();
  assert.deepEqual(posts, [{ type: 'sync-control', action: 'turn-on' }, { type: 'sync-control', action: 'dismiss-prompt' }]);
  const plain = welcomeWithCard({ show: true, pointerAt: '2026-11-13T10:05:00.000Z', lastChat: { id: 'conv-abc123def', title: 'Fix it', at: '2026-11-13T10:00:00.000Z' } });
  assert.equal(plain.card!.all((node) => node.textContent === 'Keep this project on your other machines').length, 0);
  assert.equal(plain.card!.all((node) => node.textContent === 'Turn on sync').length, 0);
});

test('dismissing is remembered in workspace state, and neither the control nor the invitation opens a dialog by itself', () => {
  const host = read('src', 'services', 'chat.ts');
  assert.match(host, /SYNC_PROMPT_DISMISSED_KEY/);
  assert.equal(SYNC_PROMPT_DISMISSED_KEY, 'nearAi.sync.promptDismissed');
  const script = read('media', 'chat', 'chat.js');
  assert.match(script, /case 'sync-status':/);
  assert.match(script, /renderSyncPrompt\(document, welcome/);
  const pickupHost = read('src', 'services', 'chat.ts');
  assert.match(pickupHost, /syncStatus: currentSyncStatus\(/, 'the card model follows the sync status');
  assert.match(pickupHost, /model\.checking/, 'the card is re-posted while it is checking');
  assert.match(pickupHost, /void pickup\.send\(\)/, 'and worked out again when the status changes');
});

test('Settings has a link that turns sync on, next to the key-file setting', () => {
  const properties = (JSON.parse(read('package.json')) as { contributes: { configuration: { properties: Record<string, { description?: string; markdownDescription?: string }> } } }).contributes.configuration.properties;
  const setting = properties['nearAi.sync.keepKeyInProject'];
  assert.match(String(setting.markdownDescription), /\(command:nearAi\.sync\.turnOn\)/);
  assert.ok(String(setting.description).length > 0, 'the plain description stays');
  assert.equal(shouldShowSyncPrompt({ syncOn: false, dismissed: false }), true);
});

// ---- Task 3: the first-run invitation ----

test('the first-run invitation has the line, a Turn on sync button and a way to say no, once, and goes when not wanted', () => {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  doc.body.append(welcome);
  const posts: unknown[] = [];
  const node = kit.renderSyncPrompt(doc, welcome, (message) => posts.push(message), true)!;
  assert.equal(welcome.children[0], node);
  assert.ok(node.all((child) => child.textContent === SYNC_PROMPT_TEXT.line).length === 1);
  const buttons = node.all((child) => child.tagName === 'button');
  assert.deepEqual(buttons.map((button) => [button.textContent, button.type]), [[SYNC_PROMPT_TEXT.turnOn, 'button'], [SYNC_PROMPT_TEXT.dismiss, 'button']]);
  assert.equal(kit.renderSyncPrompt(doc, welcome, () => undefined, true), node, 'idempotent by id');
  assert.equal(doc.body.all((child) => child.id === 'sync-prompt').length, 1);
  buttons[0].click();
  assert.deepEqual(posts, [{ type: 'sync-control', action: 'turn-on' }]);
  assert.equal(kit.renderSyncPrompt(doc, welcome, () => undefined, false), undefined);
  assert.equal(doc.getElementById('sync-prompt'), undefined, 'removed when not wanted');
  kit.renderSyncPrompt(doc, welcome, () => undefined, true);
  doc.getElementById('sync-prompt')!.all((child) => child.tagName === 'button')[1].click();
  assert.equal(doc.getElementById('sync-prompt'), undefined, 'dismissing hides it at once');
});

test('the first-run invitation steps aside while the pick-up card carries one, and comes back when the card goes', () => {
  const { doc, welcome, posts } = welcomeWithCard({});
  kit.renderSyncPrompt(doc, welcome, (message) => posts.push(message), true);
  assert.equal(doc.body.all((node) => node.textContent === SYNC_PROMPT_TEXT.line).length, 1);
  const model: Partial<PickupModel> = { show: true, pointerAt: '2026-11-13T10:05:00.000Z', syncPrompt: true };
  const card = pickup.renderPickupCard(doc, welcome, { pointerAt: '', ...model } as PickupModel, (message) => posts.push(message))!;
  assert.equal(doc.getElementById('sync-prompt'), undefined, 'one invitation on screen, the one in the card');
  assert.equal(doc.body.all((node) => node.textContent === SYNC_PROMPT_TEXT.line).length, 1);
  card.all((node) => node.tagName === 'button' && node.textContent === 'Not now')[0].click();
  assert.ok(doc.getElementById('sync-prompt'), 'back on the first-run screen once the card is gone');
  assert.equal(doc.body.all((node) => node.textContent === SYNC_PROMPT_TEXT.line).length, 1);
});
