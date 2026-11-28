import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { DataMapSnapshot } from './integration/dataMapFixture';
import { registerDataMapPanel } from './integration/dataMapPanelFixture';

function fixture(read?: () => Promise<DataMapSnapshot>) {
  let receive: ((message: unknown) => Promise<void> | void) | undefined;
  let scopeChanged: (() => Promise<void> | void) | undefined;
  const page = {
    html: '',
    onDidReceiveMessage(listener: (message: unknown) => Promise<void> | void) {
      receive = listener;
      return { dispose() { receive = undefined; } };
    },
  };
  let command: (() => Promise<void>) | undefined;
  let disposePanel: (() => void) | undefined;
  const registration = { dispose() {} };
  assert.equal(registerDataMapPanel({
    register(id, open) {
      assert.equal(id, 'nearAi.openDataMap');
      command = open;
      return registration;
    },
    createPanel() {
      return {
        webview: page,
        onDidDispose(listener) { disposePanel = listener; return { dispose() {} }; },
      };
    },
    read,
    onDidChangeScope(listener: () => Promise<void> | void) {
      scopeChanged = listener;
      return { dispose() { scopeChanged = undefined; } };
    },
  }), registration);
  return {
    page, open: () => command!(), close: () => disposePanel!(),
    message: (value: unknown) => receive?.(value),
    changeScope: () => scopeChanged?.(),
  };
}

const snapshot: DataMapSnapshot = {
  items: [{
    itemId: 'example-item', sourceId: 'example-source', name: '<inventory & notes>',
    label: { scale: 'test', level: 'Protected', compartments: [], handling: [], releasability: [] },
  }],
};

function pendingSnapshot() {
  let resolve!: (snapshot: DataMapSnapshot) => void;
  const promise = new Promise<DataMapSnapshot>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('the Data Map command loads and displays authorized inventory as plain text', async () => {
  const { promise, resolve } = pendingSnapshot();
  const view = fixture(() => promise);
  const opened = view.open();
  assert.match(view.page.html, /Loading data/);
  resolve(snapshot);
  await opened;
  assert.match(view.page.html, /default-src 'none'/);
  assert.match(view.page.html, /&lt;inventory &amp; notes&gt;/);
  assert.match(view.page.html, /Protected/);
  assert.doesNotMatch(view.page.html, /<inventory|example-source/);
});

test('the Data Map command handles empty and disconnected snapshots and drops results after close', async () => {
  const empty = fixture(async () => ({ items: [] }));
  await empty.open();
  assert.match(empty.page.html, /No data sources/);

  const disconnected = fixture(async () => { throw new Error('internal endpoint details'); });
  await disconnected.open();
  assert.match(disconnected.page.html, /Data Management is unavailable/);
  assert.doesNotMatch(disconnected.page.html, /internal endpoint details/);

  const { promise, resolve } = pendingSnapshot();
  const closed = fixture(() => promise);
  const opened = closed.open();
  closed.close();
  resolve(snapshot);
  await opened;
  assert.doesNotMatch(closed.page.html, /&lt;inventory|Protected/);
});

test('Data Management retries after a connection loss and discards responses from the previous mission', async () => {
  const delayed = pendingSnapshot();
  let attempts = 0;
  const view = fixture(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('disconnected');
    if (attempts === 2) return delayed.promise;
    return { items: [] };
  });
  await view.open();
  assert.match(view.page.html, /<button[^>]+autofocus[^>]*>Try again<\/button>/);
  await view.message({ type: 'retry', workspace: 'ignored' });
  assert.equal(attempts, 1);
  const retry = view.message({ type: 'retry' });
  assert.match(view.page.html, /Loading data/);
  await view.changeScope();
  assert.match(view.page.html, /No data sources/);
  delayed.resolve(snapshot);
  await retry;
  assert.match(view.page.html, /No data sources/);
  assert.doesNotMatch(view.page.html, /Protected/);
  view.close();
  await view.changeScope();
  await view.message({ type: 'retry' });
  assert.equal(attempts, 3);
});

test('the extension manifest keeps the synthetic Data Map command private to the trial', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert(!manifest.activationEvents.includes('onCommand:nearAi.openDataMap'));
  assert(!manifest.contributes.commands.some((item: { command: string }) => item.command === 'nearAi.openDataMap'));
  assert(!manifest.contributes.menus.commandPalette.some((item: { command: string }) => item.command === 'nearAi.openDataMap'));
});
