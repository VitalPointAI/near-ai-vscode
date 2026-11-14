// The sync control in the chat panel's bar (D-16, SYNC-04, SYNC-05, SYNC-09): present from the moment the panel opens, one click into the turn-on flow, the five
// states in plain words, errors on the control, keyboard and theme support, and the dismissible "Turn on sync" invitation. The view code runs against a
// small DOM stand-in (helpers/fakeDom.ts); the host side is pure and runs on plain node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { shouldShowSyncPrompt, SYNC_PROMPT_TEXT, SYNC_TIME_SLOT, syncControlModel, syncStatusMessage, type SyncControlModel } from '../domain/state/syncStatus';
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
  shortTime(iso: string | undefined, now?: number): string;
  TEXT: Record<string, string>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kit = require(path.join(ROOT, 'media', 'chat', 'syncControl.js')) as SyncKit;

const NOW = new Date(2026, 10, 13, 15, 30).getTime();
const AT = new Date(2026, 10, 13, 9, 5).toISOString();
/** What the control shows for a sync at AT: the panel's own short time, in the panel's own locale. */
const SYNCED_AT = `Synced · ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(AT))}`;

/** The control draws its time against the real clock (as it should for people), so tests that build the model at NOW pin the clock
    to NOW while drawing; otherwise they pass only on the day NOW names, in the machine's own time zone. */
function atClock<T>(now: number, work: () => T): T {
  const real = Date.now;
  Date.now = () => now;
  try { return work(); } finally { Date.now = real; }
}

/** The bar as panelView.ts lays it out: the profile chip, then the sync chip, its live region and the line that shows a problem's sentence. */
function bar(options: { detail?: boolean } = {}): { doc: FakeDocument; button: FakeNode; live: FakeNode; detail?: FakeNode } {
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
  let detail: FakeNode | undefined;
  if (options.detail !== false) {
    detail = doc.createElement('p');
    detail.id = 'sync-detail';
    detail.className = 'sync-detail';
    detail.hidden = true;
    row.append(detail);
  }
  doc.body.append(row);
  return { doc, button, live, ...(detail ? { detail } : {}) };
}

const STATUSES: Array<[string, SyncStatus, string, string]> = [
  ['off', { state: 'off' }, 'Sync off · Turn on', 'turn-on'],
  ['syncing', { state: 'syncing', reason: 'open' }, 'Syncing…', 'none'],
  ['synced', { state: 'synced', at: AT }, SYNCED_AT, 'sync-now'],
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

test('every status shows its exact label, a name that says the state, and posts the matching action (none while syncing)', () => atClock(NOW, () => {
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
}));

/** The label the person reads for a status: the model drawn on the control. */
function shownLabel(status: SyncStatus, now = NOW): string {
  const { doc, button } = bar();
  kit.renderSyncControl(doc, button, syncControlModel(status, now), () => undefined);
  return button.textContent;
}

test('"Synced" shows the time of the last sync on the control, today as the clock and another day with its date (same cases as 27-18, checked where they are drawn)', () => atClock(NOW, () => {
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  assert.equal(shownLabel({ state: 'synced', at: AT }), `Synced · ${clock.format(new Date(AT))}`);
  const yesterdayAt = new Date(2026, 10, 12, 23, 59);
  const other = shownLabel({ state: 'synced', at: yesterdayAt.toISOString() });
  assert.equal(other, `Synced · ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(yesterdayAt)}`);
  assert.notEqual(other, shownLabel({ state: 'synced', at: new Date(2026, 10, 13, 23, 59).toISOString() }), 'another day reads differently from today');
  assert.equal(shownLabel({ state: 'synced' }), 'Synced');
  assert.equal(shownLabel({ state: 'synced', at: 'not a time' }), 'Synced');
}));

// ---- Plan 27-25 (G-27-4d, times): one formatter in the panel for every display time ----

test('tracer: shortTime gives the clock for today, the short month and day and the clock for another day, and nothing for a missing or invalid time', () => {
  const at = new Date(2026, 10, 13, 9, 5);
  assert.equal(kit.shortTime(at.toISOString(), NOW), new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at));
  const earlier = new Date(2026, 10, 12, 23, 59);
  assert.equal(kit.shortTime(earlier.toISOString(), NOW), new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(earlier));
  assert.equal(kit.shortTime(undefined, NOW), '');
  assert.equal(kit.shortTime('', NOW), '');
  assert.equal(kit.shortTime('not a time', NOW), '');
});

test('tracer: the same instant reads the same on the pick-up card and on the sync control, today and on another day', () => {
  const today = new Date();
  for (const at of [new Date(today.getTime() - 60_000), new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12, 0)]) {
    const iso = at.toISOString();
    const control = shownLabel({ state: 'synced', at: iso }, Date.now());
    const { card } = welcomeWithCard({ show: true, pointerAt: iso, lastChat: { id: 'conv-abc123def', title: 'Fix it', at: iso } });
    const line = card!.all((node) => node.textContent.startsWith('Last chat: '))[0].textContent;
    const onCard = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')'));
    assert.ok(onCard.length > 0, 'the card shows a time');
    assert.equal(control, `Synced · ${kit.shortTime(iso, Date.now())}`);
    assert.equal(onCard, kit.shortTime(iso, Date.now()), 'the card and the control show the instant the same way');
  }
});

test('tracer: the host model carries the time as ISO plus a slot in label, name and tooltip (no digits, no clock formatting on the host)', () => {
  const model = syncControlModel({ state: 'synced', at: AT }, NOW);
  assert.equal(model.at, AT);
  for (const text of [model.label, model.ariaLabel, model.title]) {
    assert.ok(text.includes(SYNC_TIME_SLOT), text);
    assert.doesNotMatch(text, /\d/, `no clock time of the host's own: ${text}`);
  }
  for (const status of [{ state: 'synced' }, { state: 'synced', at: 'not a time' }] as SyncStatus[]) {
    const plain = syncControlModel(status, NOW);
    assert.equal(plain.label, 'Synced');
    assert.equal(plain.at, undefined);
    for (const text of [plain.label, plain.ariaLabel, plain.title]) assert.ok(!text.includes(SYNC_TIME_SLOT), text);
  }
  assert.equal('at' in syncControlModel({ state: 'off' }, NOW), false);
  const source = read('src', 'domain', 'state', 'syncStatus.ts');
  assert.doesNotMatch(source, /getHours|getMinutes|MONTHS|toLocale/, 'the host formats no clock time for display');
});

test('tracer: the webview replaces the slot in the label, the accessible name and the tooltip with the panel time', () => {
  const { doc, button } = bar();
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), () => undefined);
  const time = kit.shortTime(AT, Date.now());
  assert.equal(button.textContent, `Synced · ${time}`);
  assert.ok((button.attributes.get('aria-label') ?? '').includes(time));
  assert.ok((button.attributes.get('title') ?? '').includes(time));
  for (const text of [button.textContent, button.attributes.get('aria-label') ?? '', button.attributes.get('title') ?? '']) assert.ok(!text.includes(SYNC_TIME_SLOT), text);
  assert.doesNotMatch(read('media', 'chat', 'pickup.js').replace(/^\s*\/\/.*$/gm, ''), /toLocaleTimeString|toLocaleString|toLocaleDateString/, 'the card keeps no formatter of its own');
});

test('a problem is shown on the control in plain words, in the name and the tooltip, not only in a log', () => {
  const model = syncControlModel({ state: 'attention', message: 'Couldn\'t reach GitHub, will retry.' }, NOW);
  assert.equal(model.title, 'Couldn\'t reach GitHub, will retry.');
  assert.match(model.ariaLabel, /Couldn't reach GitHub, will retry\./);
  const signIn = syncControlModel({ state: 'attention', message: 'Sync needs you to sign in. Choose Sync Project Now.' }, NOW);
  assert.match(signIn.title, /Choose Sync Project Now\./);
  assert.equal(syncControlModel({ state: 'attention' }, NOW).title.length > 0, true, 'a problem with no sentence still says something');
});

test('a status change re-renders the same button (no second control), and the live region says the new state once', () => atClock(NOW, () => {
  const { doc, button, live } = bar();
  const posts: unknown[] = [];
  const post = (message: unknown): number => posts.push(message);
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'off' }, NOW), post);
  assert.equal(live.textContent, '', 'the first render says nothing');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'syncing', reason: 'manual' }, NOW), post);
  assert.equal(live.textContent, 'Project sync: Syncing…');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), post);
  assert.equal(live.textContent, `Project sync: ${SYNCED_AT}`, 'the live region says the label as shown, with the time, not the slot');
  live.textContent = '';
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), post);
  assert.equal(live.textContent, '', 'the same state again is not announced again');
  assert.equal(doc.body.all((node) => node.id === 'sync').length, 1, 'one control');
  button.click();
  assert.deepEqual(posts, [{ type: 'sync-control', action: 'sync-now' }], 'one listener, whatever the number of renders');
}));

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

/** The first-run screen as panelView.ts lays it out: the connect panel (shown until a profile works) and the ready area (hidden until then). */
function firstRun(): { doc: FakeDocument; welcome: FakeNode; connect: FakeNode; ready: FakeNode } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  const connect = doc.createElement('div');
  connect.id = 'welcome-connect';
  const ready = doc.createElement('div');
  ready.id = 'welcome-ready';
  ready.hidden = true;
  welcome.append(connect, ready);
  doc.body.append(welcome);
  return { doc, welcome, connect, ready };
}

test('the first-run invitation has the line, a Turn on sync button and a way to say no, once, and goes when not wanted', () => {
  const { doc, ready: welcome } = firstRun();
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
  const { doc, ready: welcome } = firstRun();
  const posts: unknown[] = [];
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

// ---- Plan 27-25 (G-27-4d, first run): connect NEAR AI first; the invitation follows once a profile works ----

test('the sync-status case puts the invitation in the ready area, and the pick-up card line stays as it was', () => {
  const script = read('media', 'chat', 'chat.js');
  assert.equal((script.match(/renderSyncPrompt\(document, welcomeReady/g) ?? []).length, 1);
  assert.doesNotMatch(script, /renderSyncPrompt\(document, welcome,/);
  assert.match(script, /case 'pickup-card': pickupKit\.renderPickupCard\(document, welcomeReady, m\.model, post, \(\) => input\.focus\(\)\); break;/);
  assert.match(script, /const welcomeReady = \$\('welcome-ready'\) \|\| welcome;/, 'it falls back to the whole welcome section when there is no ready area');
});

test('the invitation lives inside the ready area: not in the connect panel, not shown until a profile works, once when it does', () => {
  const { doc, welcome, connect, ready } = firstRun();
  const node = kit.renderSyncPrompt(doc, ready, () => undefined, true)!;
  assert.equal(node.parent, ready);
  assert.equal(connect.all((child) => child.id === 'sync-prompt').length, 0, 'nothing of it in the connect panel');
  assert.equal(welcome.children[0], connect, 'the connect panel is still the first thing on the screen');
  const shown = (element: FakeNode): boolean => { for (let at: FakeNode | undefined = element; at; at = at.parent) if (at.hidden) return false; return true; };
  assert.equal(shown(node), false, 'hidden with the ready area while only the connect panel shows');
  ready.hidden = false;
  connect.hidden = true;
  assert.equal(shown(node), true);
  assert.equal(doc.body.all((child) => child.id === 'sync-prompt').length, 1, 'exactly once');
  kit.renderSyncPrompt(doc, ready, () => undefined, true);
  assert.equal(doc.body.all((child) => child.id === 'sync-prompt').length, 1, 'still once after another status');
});

test('chat.css gives the invitation room and a box like the setup nudge, in theme variables only', () => {
  const css = read('media', 'chat', 'chat.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = rulesOf(css).find((entry) => entry.selector.split(',').some((part) => part.trim() === '.sync-prompt'));
  assert.ok(rule, 'a .sync-prompt rule');
  const margins = [...rule.body.matchAll(/margin(?:-(top|bottom))?:\s*([^;]+);/g)];
  assert.ok(margins.length > 0, 'it sets margins');
  const px = (value: string): number[] => [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  const all = margins.find((entry) => !entry[1]);
  if (all) {
    const parts = px(all[2]);
    const [top, , bottom] = parts.length === 1 ? [parts[0], parts[0], parts[0]] : parts.length === 2 ? [parts[0], parts[1], parts[0]] : parts;
    assert.ok(top >= 8 && bottom >= 8, `top ${top}px and bottom ${bottom}px`);
  } else {
    assert.ok(Math.min(...px(margins.find((entry) => entry[1] === 'top')![2])) >= 8, 'top margin');
    assert.ok(Math.min(...px(margins.find((entry) => entry[1] === 'bottom')![2])) >= 8, 'bottom margin');
  }
  assert.match(rule.body, /padding:/);
  assert.match(rule.body, /border:[^;]*var\(--vscode-/);
  assert.match(rule.body, /background:[^;]*var\(--vscode-/);
  assert.doesNotMatch(rule.body, /#[0-9a-fA-F]{3,8}\b(?!\w)|rgba?\(|hsla?\(/, 'no hard-coded colour');
});

// ---- Plan 27-22 (G-27-4c): the plain sentence of a problem is visible text under the control, not only the tooltip ----

const SENTENCE = 'Couldn\'t reach GitHub, will retry.';

test('the attention model carries its plain sentence as detail (the fallback when it has none); no other state has a detail', () => {
  assert.equal(syncControlModel({ state: 'attention', message: SENTENCE }, NOW).detail, SENTENCE);
  assert.equal(syncControlModel({ state: 'attention', message: '  ' }, NOW).detail, 'The last sync did not finish.');
  assert.equal(syncControlModel({ state: 'attention' }, NOW).detail, 'The last sync did not finish.');
  assert.equal(syncControlModel({ state: 'attention', message: SENTENCE }, NOW).label, 'Needs attention', 'the label is unchanged');
  for (const [name, status] of STATUSES) {
    if (name === 'attention') continue;
    assert.equal('detail' in syncControlModel(status, NOW), false, `${name} has no detail`);
  }
});

test('rendering attention shows the sentence as text in #sync-detail and describes the button by it; the next state empties, hides and unlinks it', () => {
  const { doc, button, detail } = bar();
  assert.ok(detail);
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'off' }, NOW), () => undefined);
  assert.equal(detail.hidden, true);
  assert.equal(detail.textContent, '');
  assert.equal(button.attributes.get('aria-describedby'), undefined);
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'attention', message: SENTENCE }, NOW), () => undefined);
  assert.equal(detail.textContent, SENTENCE);
  assert.equal(detail.hidden, false);
  assert.equal(button.attributes.get('aria-describedby'), 'sync-detail');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'synced', at: AT }, NOW), () => undefined);
  assert.equal(detail.textContent, '');
  assert.equal(detail.hidden, true);
  assert.equal(button.attributes.has('aria-describedby'), false, 'the description goes with the problem');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'attention', message: 'Sync needs you to sign in.' }, NOW), () => undefined);
  assert.equal(detail.textContent, 'Sync needs you to sign in.');
  assert.equal(doc.body.all((node) => node.id === 'sync-detail').length, 1, 'the same detail element, never a second one');
  assert.equal(doc.body.all((node) => node.id === 'sync').length, 1, 'and the same one button');
});

test('a sentence with markup characters is set as text, never as HTML', () => {
  const { doc, button, detail } = bar();
  assert.ok(detail);
  const sentence = 'Failed <img src=x onerror=alert(1)> & "more"';
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'attention', message: sentence }, NOW), () => undefined);
  assert.equal(detail.textContent, sentence);
  assert.equal(detail.children.length, 0);
  assert.doesNotMatch(read('media', 'chat', 'syncControl.js'), /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('a page without the detail line still renders the control (older markup, other hosts)', () => {
  const { doc, button } = bar({ detail: false });
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'attention', message: SENTENCE }, NOW), () => undefined);
  assert.equal(button.textContent, 'Needs attention');
  kit.renderSyncControl(doc, button, syncControlModel({ state: 'off' }, NOW), () => undefined);
  assert.equal(button.attributes.has('aria-describedby'), false);
});

test('a sentence with a password in a URL or a GitHub token reaches the page redacted in the detail too', () => {
  const fakeToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
  const url = syncPanelMessage({ state: 'attention', message: 'Failed for https://user:pw@github.com/x/y.git' }, undefined, NOW);
  assert.ok(url.model.detail && url.model.detail.length > 0);
  assert.doesNotMatch(url.model.detail, /user:pw|pw@/);
  const token = syncPanelMessage({ state: 'attention', message: `Rejected token ${fakeToken}` }, undefined, NOW);
  assert.ok(token.model.detail && !token.model.detail.includes(fakeToken) && !token.model.detail.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  const { doc, button, detail } = bar();
  kit.renderSyncControl(doc, button, token.model, () => undefined);
  assert.ok(detail && !detail.textContent.includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'what is on the page is the redacted sentence');
});

test('the bar markup has the detail paragraph right after the live region and before the row break, hidden, with its class', () => {
  const panel = read('src', 'services', 'panelView.ts');
  assert.equal((panel.match(/id="sync-detail"/g) ?? []).length, 1);
  assert.match(panel, /<p id="sync-detail" class="sync-detail"[^>]*\bhidden\b[^>]*><\/p>/);
  const live = panel.indexOf('id="sync-live"');
  const detail = panel.indexOf('id="sync-detail"');
  const rowBreak = panel.indexOf('bar-break');
  const model = panel.indexOf('id="model"');
  assert.ok(live > 0 && live < detail && detail < rowBreak && rowBreak < model, 'sync-live, sync-detail, the row break, then the pickers');
});

test('chat.css shows the detail as a full-row, wrapping line in a theme colour', () => {
  const css = read('media', 'chat', 'chat.css');
  const rule = css.match(/^\.sync-detail \{[^}]*\}/m)?.[0] ?? '';
  assert.ok(rule, 'a .sync-detail rule');
  assert.match(rule, /flex:\s*0 0 100%|flex-basis:\s*100%/);
  assert.match(rule, /--vscode-errorForeground|--vscode-inputValidation-warningForeground|--vscode-editorWarning-foreground/);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/);
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b(?!\w)|rgba?\(|hsla?\(/, 'no hard-coded colour');
});

// ---- Plan 27-22 (G-27-4a): fast guards for the layout rules, so a later edit to chat.css or a longer label fails without a real window ----

/** chat.css without comments, split into its top-level text and its @media blocks (query and body). */
function splitCss(source: string): { top: string; media: Array<{ query: string; body: string }> } {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const media: Array<{ query: string; body: string }> = [];
  let top = '';
  let at = 0;
  while (at < css.length) {
    const start = css.indexOf('@media', at);
    if (start < 0) { top += css.slice(at); break; }
    top += css.slice(at, start);
    const open = css.indexOf('{', start);
    let depth = 1;
    let end = open + 1;
    while (depth > 0 && end < css.length) { if (css[end] === '{') depth += 1; else if (css[end] === '}') depth -= 1; end += 1; }
    media.push({ query: css.slice(start + 6, open).trim(), body: css.slice(open + 1, end - 1) });
    at = end;
  }
  return { top, media };
}

/** Every `selector { declarations }` in a stylesheet text. */
function rulesOf(text: string): Array<{ selector: string; body: string }> {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

test('label budget: every label of every state, with the longest time text, fits a 220 px row at the chip font (at most 26 characters)', () => {
  const times = [AT, new Date(2026, 8, 30, 12, 59).toISOString(), new Date(2026, 11, 28, 23, 59).toISOString(), new Date(2026, 4, 28, 10, 8).toISOString()];
  const labels = [
    ...STATUSES.map(([, status]) => shownLabel(status)),
    ...times.map((at) => shownLabel({ state: 'synced', at }))
  ];
  for (const label of labels) assert.ok(label.length <= 26, `"${label}" is ${label.length} characters`);
  assert.ok(Math.max(...labels.map((label) => label.length)) >= 22, 'the budget is measured against the longest real label, not a short one');
});

test('chat.css guard: the bar wraps at every width, profile and sync never shrink or get capped below the row, the row break and the detail line are full-row', () => {
  const { top, media } = splitCss(read('media', 'chat', 'chat.css'));
  const all = [...rulesOf(top), ...media.flatMap((block) => rulesOf(block.body))];
  // The bar wraps outside any media query, so it wraps at every width.
  const bar = rulesOf(top).find((rule) => rule.selector === '.composer .bar');
  assert.ok(bar && /flex-wrap:\s*wrap/.test(bar.body), 'the composer bar wraps outside any media query');
  // #profile and #sync: no shrinking, and no max-width below the full row, in any rule that names them.
  const chips = all.filter((rule) => rule.selector.split(',').some((part) => /#(profile|sync)(?![\w-])/.test(part)));
  assert.ok(chips.length >= 2);
  for (const rule of chips) {
    for (const cap of rule.body.matchAll(/max-width:\s*([^;]+);?/g)) assert.equal(cap[1].trim(), '100%', `${rule.selector} caps its width at ${cap[1].trim()}`);
  }
  const both = chips.find((rule) => /#profile/.test(rule.selector) && /#sync(?![\w-])/.test(rule.selector));
  assert.ok(both && (/flex:\s*none/.test(both.body) || /flex-shrink:\s*0/.test(both.body)), 'profile and sync have flex none');
  assert.match(both.body, /max-width:\s*100%/);
  assert.match(both.body, /white-space:\s*normal/, 'a chip too wide for a row wraps its words instead of being cut');
  // The row break is a full-row item in a max-width query of at least 480 px, and hidden above it.
  const rowBreakBlocks = media.filter((block) => rulesOf(block.body).some((rule) => /\.bar-break/.test(rule.selector) && /flex-basis:\s*100%/.test(rule.body)));
  assert.ok(rowBreakBlocks.length >= 1, 'a bar-break rule with flex-basis 100% in a media query');
  for (const block of rowBreakBlocks) assert.ok(Number(block.query.match(/max-width:\s*(\d+)px/)?.[1] ?? 0) >= 480, `the row break holds up to at least 480px: ${block.query}`);
  const base = rulesOf(top).find((rule) => /\.bar-break/.test(rule.selector));
  assert.ok(base && /display:\s*none/.test(base.body), 'above that width the pickers share the first row when they fit');
  // The detail line takes a full row.
  const detail = rulesOf(top).find((rule) => rule.selector === '.sync-detail');
  assert.ok(detail && (/flex-basis:\s*100%/.test(detail.body) || /flex:\s*0 0 100%/.test(detail.body)), 'the detail line is a full-row item');
});
