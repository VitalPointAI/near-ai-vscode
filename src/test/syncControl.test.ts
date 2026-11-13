// The sync control in the chat panel's bar (D-16, SYNC-04, SYNC-05, SYNC-09): present from the moment the panel opens, one click into the turn-on flow, the five
// states in plain words, errors on the control, keyboard and theme support, and the dismissible "Turn on sync" invitation. The view code runs against a
// small DOM stand-in (helpers/fakeDom.ts); the host side is pure and runs on plain node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { syncControlModel, syncStatusMessage, type SyncControlModel } from '../domain/state/syncStatus';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { syncPanelMessage } from '../services/syncPanel';
import type { SyncStatus } from '../services/syncFlows';
import { FakeDocument, FakeNode } from './helpers/fakeDom';

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
