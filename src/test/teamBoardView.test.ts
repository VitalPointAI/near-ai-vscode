// The Team Board host (Phase 62 plan 08): the panel and the view provider on a real team session over real clones, the page protocol, the nonce CSP,
// the message parser, throttled posting and the native prompts of a move. Timers of the session and of the board's own throttle fire by hand; git,
// the log and the roster are real. Lazy requires keep every vscode import behind the stub.
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { importPlans } from '../team/importPlans';
import { openLog, remoteEventCount, rootOf, storageOf } from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { LiveTimers, turn, until, withLiveTeam } from './helpers/teamLiveRig';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview, RecordedWebviewPanel } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
const boardModule = require('../services/team/boardView') as typeof import('../services/team/boardView');
test.after(() => { uninstall(); });

const { TeamSession, projectAuditSink } = sessionModule;
const { createTeamStatusBar } = barModule;
const { BOARD_PANEL_TYPE, BOARD_SCRIPTS, BOARD_STYLES, BOARD_VIEW_ID, boardHtml, boardTap, parseBoardMessage, registerTeamBoard } = boardModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;
type SessionDeps = Parameters<typeof TeamSession.start>[0];

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const MEDIA_BOARD = path.join(EXTENSION_ROOT, 'media', 'board');
// The fixture's plan:90-01 has a summary, so it is Done; plan:90-02 is the one that is Ready.
const READY_PLAN = 'plan:90-02';

interface Started { session: Session; lines: string[]; timers: LiveTimers }

async function startSession(rig: Rig, who: 'owner' | Participant, overrides: Partial<Omit<SessionDeps, 'focused'>> = {}): Promise<Started> {
  const v = stub.vscode as {
    window: {
      showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
      showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
    };
  };
  const person = who === 'owner' ? undefined : who;
  const timers = new LiveTimers();
  const lines: string[] = [];
  const root = rootOf(rig, person === undefined ? 'a' : person.clone);
  const statusBar = createTeamStatusBar();
  assert.ok(rig.teamFile !== undefined);
  const session = await TeamSession.start({
    projectRoot: root, globalStorageDir: person === undefined ? rig.owner.globalStorageDir : person.globalStorageDir, teamFile: rig.teamFile,
    secrets: person === undefined ? rig.owner.secrets : person.secrets,
    output: { appendLine: (line) => { lines.push(line); }, show: () => undefined },
    statusBar, audit: projectAuditSink(root),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => true, timers, nearBaseUrl: rig.fake.baseUrl, autoImport: false,
    ...overrides
  });
  if (overrides.timers === undefined) await until(() => timers.live.length === 1, 'the first poll to be armed');
  return { session, lines, timers };
}

async function importFixture(rig: Rig): Promise<void> {
  const owner = await openLog(rig, 'owner');
  const result = await importPlans({
    log: owner.log, source: { projectRoot: rootOf(rig, 'a'), remote: 'origin', branch: 'main' }, storageDir: storageOf(rig, 'owner'), mode: 'command'
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
}

interface StateMessage { type: 'state'; model: { cards: Array<{ id: string; column: string; held: boolean }>; status: { kind: string } } }
const states = (record: RecordedWebview): StateMessage[] => record.posted.filter((message): message is StateMessage => (message as { type?: string }).type === 'state');
const cardOf = (message: StateMessage | undefined, id: string): { id: string; column: string; held: boolean } | undefined => message?.model.cards.find((card) => card.id === id);

function openBoard(session: Session, timers: LiveTimers, lines: string[]): { panel: RecordedWebviewPanel; board: ReturnType<typeof registerTeamBoard> } {
  const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
  const board = registerTeamBoard(context as never, { session: () => session, output: { appendLine: (line) => { lines.push(line); }, show: () => undefined }, timers });
  board.openPanel();
  const panel = stub.webviewPanels[stub.webviewPanels.length - 1];
  assert.ok(panel !== undefined, 'a panel was created');
  return { panel, board };
}

function resetStub(): void {
  stub.webviewPanels.length = 0;
  stub.viewProviders.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.notificationOptions.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.setMessageResponder(undefined);
  stub.externalCommands.length = 0;
  stub.commands.clear();
  boardTap.toView = undefined;
  boardTap.fromView = undefined;
  boardTap.request = undefined;
}

test('tracer: the panel opens on a real team session, gets the first state, posts a hold and gets the card back in Backlog', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const ui = new LiveTimers();
    const { panel, board } = openBoard(a.session, ui, a.lines);
    try {
      const sent: unknown[] = [];
      boardTap.fromView = (message) => { sent.push(message); };
      const seen: unknown[] = [];
      boardTap.toView = (message) => { seen.push(message); };

      assert.equal(states(panel).length, 0, 'nothing is posted before the page says it is ready');
      await panel.receive({ type: 'ready' });
      const first = states(panel)[0];
      assert.ok(first !== undefined, 'the first state message arrived');
      assert.equal(cardOf(first, READY_PLAN)?.column, 'ready');
      assert.equal(cardOf(first, READY_PLAN)?.held, false);
      assert.equal(first.model.status.kind, 'live');
      assert.deepEqual(sent, [{ type: 'ready' }], 'the tap saw the page message');
      assert.equal(seen[0], panel.posted[0], 'the tap saw the host message');

      await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
      const remote = await openLog(rig, 'owner');
      assert.equal(remote.log.state().items.get(READY_PLAN)?.hold, true, 'the remote log gained the hold');
      // The change reaches the page on the board's next post, never faster than the throttle.
      await until(() => ui.live.length === 1, 'the throttled post to be armed');
      ui.fire();
      await until(() => states(panel).length === 2, 'the second state message');
      const second = states(panel)[1];
      assert.equal(cardOf(second, READY_PLAN)?.column, 'backlog');
      assert.equal(cardOf(second, READY_PLAN)?.held, true);
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
  });
});

test('the panel is one editor tab: a second Open reveals it, and it asks for scripts, no retained context and only media/board', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const { panel, board } = openBoard(a.session, new LiveTimers(), a.lines);
    try {
      assert.equal(panel.viewType, BOARD_PANEL_TYPE);
      assert.equal(panel.title, 'Team Board');
      assert.equal(panel.options.enableScripts, true);
      assert.notEqual(panel.options.retainContextWhenHidden, true, 'the page keeps its state with getState and setState, not by staying alive');
      assert.deepEqual(panel.options.localResourceRoots?.map((root) => root.fsPath), [MEDIA_BOARD]);
      board.openPanel();
      assert.equal(stub.webviewPanels.length, 1, 'no second panel');
      assert.equal(panel.revealCalls, 1, 'the open panel was revealed');
      panel.dispose();
      board.openPanel();
      assert.equal(stub.webviewPanels.length, 2, 'a closed panel opens again');
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
  });
});

test('the sidebar view provider is registered once under the view id with no retained context, and serves the same page', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
    const board = registerTeamBoard(context as never, { session: () => a.session, output: { appendLine: (line) => { a.lines.push(line); }, show: () => undefined }, timers: new LiveTimers() });
    try {
      assert.equal(stub.viewProviders.length, 1);
      const registered = stub.viewProviders[0];
      assert.equal(registered?.viewType, BOARD_VIEW_ID);
      assert.equal(registered?.options, undefined, 'no retainContextWhenHidden option is passed');
      const { view, record } = stub.createWebviewView();
      registered?.provider.resolveWebviewView(view);
      assert.equal(record.options.enableScripts, true);
      assert.deepEqual(record.options.localResourceRoots?.map((root) => root.fsPath), [MEDIA_BOARD]);
      assert.ok(record.html.includes('script-src'), 'the view has the page');
      await record.receive({ type: 'ready' });
      assert.equal(cardOf(states(record)[0], READY_PLAN)?.column, 'ready');
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
  });
});

test('the page has one nonce CSP, one script tag per client file in order and no inline script, style, remote address or font source', () => {
  const uri = stub.vscode as { Uri: { file(path: string): { fsPath: string } } };
  const media = uri.Uri.file(MEDIA_BOARD);
  const webview = { cspSource: 'CSP_SOURCE', asWebviewUri: (value: { fsPath: string }) => ({ toString: () => `webview://${value.fsPath}` }) };
  for (const surface of ['view', 'panel'] as const) {
    const html = boardHtml(webview as never, media as never, 'NONCE', surface);
    assert.equal(html.match(/<meta http-equiv="Content-Security-Policy"/g)?.length, 1, 'one CSP meta');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    assert.equal(csp, "default-src 'none'; style-src CSP_SOURCE; script-src 'nonce-NONCE';");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([^<]*)<\/script>/g)];
    assert.equal(scripts.length, BOARD_SCRIPTS.length, 'one script tag per client file');
    assert.equal((html.match(/<script\b/g) ?? []).length, BOARD_SCRIPTS.length, 'no script tag the pattern missed');
    scripts.forEach((script, index) => {
      assert.ok((script[1] ?? '').includes('nonce="NONCE"'), 'each script carries the nonce');
      assert.ok((script[1] ?? '').includes(`src="webview://${MEDIA_BOARD}/${BOARD_SCRIPTS[index]}"`), `script ${index} is ${BOARD_SCRIPTS[index]}`);
      assert.equal(script[2], '', 'no inline script body');
    });
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    assert.equal(links.length, BOARD_STYLES.length);
    BOARD_STYLES.forEach((file, index) => { assert.ok((links[index]?.[0] ?? '').includes(`href="webview://${MEDIA_BOARD}/${file}"`)); });
    assert.equal(/\sstyle\s*=/.test(html), false, 'no inline style attribute');
    assert.equal(/<style\b/.test(html), false, 'no style element');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no inline event handler');
    assert.equal(/https?:/.test(html), false, 'no remote address');
    assert.equal(html.includes('font-src'), false, 'icons are inline SVG, so no font source');
    assert.ok(html.includes('id="root"') && html.includes('id="live"'), 'the root and the live region the client expects');
    assert.ok(html.includes(`data-surface="${surface}"`));
  }
});

test('host-request reaches the visible surfaces and nothing that is hidden', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const { panel, board } = openBoard(a.session, new LiveTimers(), a.lines);
    try {
      const { view, record } = stub.createWebviewView();
      stub.viewProviders[0]?.provider.resolveWebviewView(view);
      record.setVisible(false);
      assert.ok(boardTap.request !== undefined, 'the controller offers the request hook');
      await boardTap.request?.({ type: 'retry' });
      assert.deepEqual(panel.posted.filter((message) => (message as { type?: string }).type === 'host-request'), [{ type: 'host-request', payload: { type: 'retry' } }]);
      assert.equal(record.posted.length, 0, 'the hidden view got nothing');
      assert.equal(record.postedWhileHidden, 0);
      panel.setVisible(false);
      await boardTap.request?.({ type: 'retry' });
      assert.equal(panel.posted.filter((message) => (message as { type?: string }).type === 'host-request').length, 1, 'a hidden panel gets nothing either');
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
  });
});

// ---- the parser ------------------------------------------------------------------------------------------------------------------------------

const BOARD_ITEM = 'item:01HZX3Q7VY8M2K4N6P9R0S1T2W';

test('parseBoardMessage accepts exactly the contract and returns the fields it checked', () => {
  assert.deepEqual(parseBoardMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseBoardMessage({ type: 'visible', value: true }), { type: 'visible', value: true });
  assert.deepEqual(parseBoardMessage({ type: 'move', itemId: READY_PLAN, target: 'hold' }), { type: 'move', itemId: READY_PLAN, target: 'hold' });
  assert.deepEqual(parseBoardMessage({ type: 'move', itemId: BOARD_ITEM, target: 'unblock' }), { type: 'move', itemId: BOARD_ITEM, target: 'unblock' });
  assert.deepEqual(parseBoardMessage({ type: 'detail', itemId: 'phase:90' }), { type: 'detail', itemId: 'phase:90' });
  for (const type of ['import-plans', 'open-board', 'retry', 'show-details'] as const) assert.deepEqual(parseBoardMessage({ type }), { type });
  assert.deepEqual(
    parseBoardMessage({ type: 'new-item', draft: { kind: 'bug', title: 'Fix it', scope: ['src/a/**'], estimate: 48000, description: 'Why' } }),
    { type: 'new-item', draft: { kind: 'bug', title: 'Fix it', scope: ['src/a/**'], estimate: 48000, description: 'Why' } }
  );
  assert.deepEqual(parseBoardMessage({ type: 'new-item', draft: { kind: 'chore', title: 'Minimal', scope: [] } }), { type: 'new-item', draft: { kind: 'chore', title: 'Minimal', scope: [] } });
  assert.deepEqual(parseBoardMessage({ type: 'edit-item', itemId: BOARD_ITEM, changes: { title: 'New title', estimate: 1000 } }), { type: 'edit-item', itemId: BOARD_ITEM, changes: { title: 'New title', estimate: 1000 } });
});

test('parseBoardMessage refuses anything else: extra or missing keys, odd ids, unknown moves, long text, bad numbers and non-objects', () => {
  const hostile: unknown[] = [
    undefined, null, 'ready', 7, [], [{ type: 'ready' }], {}, { type: 'unknown' }, { type: 'ready', extra: 1 }, { type: 'ready', role: 'owner' },
    { type: 'visible' }, { type: 'visible', value: 'yes' }, { type: 'visible', value: true, extra: true },
    { type: 'move', itemId: READY_PLAN }, { type: 'move', itemId: READY_PLAN, target: 'delete' }, { type: 'move', itemId: READY_PLAN, target: 'hold', reason: 'x' },
    { type: 'move', itemId: READY_PLAN, target: 'hold', role: 'owner' }, { type: 'move', itemId: READY_PLAN, target: '__proto__' }, { type: 'move', itemId: READY_PLAN, target: 'toString' },
    { type: 'move', itemId: `plan:${'9'.repeat(500)}`, target: 'hold' }, { type: 'move', itemId: 'x'.repeat(500), target: 'hold' }, { type: 'move', itemId: 'plan:../x', target: 'hold' },
    { type: 'move', itemId: 'item:not-a-ulid', target: 'hold' }, { type: 'move', itemId: 7, target: 'hold' },
    { type: 'detail' }, { type: 'detail', itemId: 'nope' }, { type: 'detail', itemId: READY_PLAN, extra: 1 },
    { type: 'import-plans', milestone: 'v1' }, JSON.parse('{"type":"move","itemId":"plan:90-01","target":"hold","__proto__":{"admin":true}}'),
    JSON.parse('{"__proto__":{"type":"ready"}}'),
    { type: 'new-item' }, { type: 'new-item', draft: null }, { type: 'new-item', draft: { kind: 'plan', title: 'x', scope: [] } },
    { type: 'new-item', draft: { kind: 'bug', title: '', scope: [] } }, { type: 'new-item', draft: { kind: 'bug', title: 't'.repeat(201), scope: [] } },
    { type: 'new-item', draft: { kind: 'bug', title: 't', scope: [], description: 'd'.repeat(2001) } },
    { type: 'new-item', draft: { kind: 'bug', title: 't', scope: Array.from({ length: 65 }, () => 'src/a') } },
    { type: 'new-item', draft: { kind: 'bug', title: 't', scope: ['s'.repeat(201)] } }, { type: 'new-item', draft: { kind: 'bug', title: 't', scope: 'src/a' } },
    { type: 'new-item', draft: { kind: 'bug', title: 't', scope: [], estimate: 0 } }, { type: 'new-item', draft: { kind: 'bug', title: 't', scope: [], estimate: 1.5 } },
    { type: 'new-item', draft: { kind: 'bug', title: 't', scope: [], estimate: 1e12 + 1 } }, { type: 'new-item', draft: { kind: 'bug', title: 't', scope: [], estimate: '5' } },
    { type: 'new-item', draft: { kind: 'bug', title: 't', scope: [], role: 'owner' } },
    { type: 'edit-item', itemId: BOARD_ITEM }, { type: 'edit-item', itemId: BOARD_ITEM, changes: {} },
    { type: 'edit-item', itemId: BOARD_ITEM, changes: { title: 't'.repeat(201) } }, { type: 'edit-item', itemId: BOARD_ITEM, changes: { state: 'done' } }
  ];
  for (const value of hostile) assert.equal(parseBoardMessage(value), undefined, JSON.stringify(value));
});

// ---- moves with native prompts ---------------------------------------------------------------------------------------------------------------

const DEPENDENT_PLAN = 'plan:91.1-01';
const WAITING_FOR_KEY = 'waiting for the API key';

const lastOf = (record: RecordedWebview, type: string): Record<string, unknown> | undefined =>
  [...record.posted].reverse().find((message): message is Record<string, unknown> => (message as { type?: string }).type === type);

// A move through a freshly opened board of one computer. Returns what a test needs to watch.
async function withBoard(who: 'owner' | 'dev' | 'lead', run: (ctx: { rig: Rig; started: Started; panel: RecordedWebviewPanel; ui: LiveTimers; board: ReturnType<typeof registerTeamBoard> }) => Promise<void>): Promise<void> {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const started = await startSession(rig, who === 'owner' ? 'owner' : who === 'dev' ? rig.dev : rig.lead);
    const ui = new LiveTimers();
    const { panel, board } = openBoard(started.session, ui, started.lines);
    try {
      await panel.receive({ type: 'ready' });
      await run({ rig, started, panel, ui, board });
    } finally {
      board.controller.dispose();
      started.session.dispose();
    }
  });
}

test('block asks for the reason in a native box with the UI-SPEC words, validates it, and appends the answer', async () => {
  await withBoard('owner', async ({ rig, started, panel }) => {
    stub.inputAnswers.push(WAITING_FOR_KEY);
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'block' });
    const request = stub.inputRequests[0];
    assert.equal(request?.title, 'Block 90-02');
    assert.equal(request?.prompt, 'Why is this blocked? The team will see your answer.');
    assert.equal(request?.placeHolder, 'For example: waiting for the API key');
    assert.equal((request as { ignoreFocusOut?: boolean } | undefined)?.ignoreFocusOut, true);
    assert.equal(request?.validateInput?.(''), 'Enter a reason, up to 200 characters.');
    assert.equal(request?.validateInput?.('   '), 'Enter a reason, up to 200 characters.');
    assert.equal(request?.validateInput?.('x'.repeat(201)), 'Enter a reason, up to 200 characters.');
    assert.equal(request?.validateInput?.(WAITING_FOR_KEY), undefined);
    assert.equal(stub.notifications.length, 0, 'the reason box is the confirmation, no modal');
    assert.equal(started.session.state().items.get(READY_PLAN)?.blocked?.reason, WAITING_FOR_KEY);
    assert.equal(lastOf(panel, 'refused'), undefined);
    assert.equal((await openLog(rig, 'owner')).log.state().items.get(READY_PLAN)?.blocked?.reason, WAITING_FOR_KEY);
  });
});

test('a dismissed reason box clears the pending line with an empty refusal and writes nothing', async () => {
  await withBoard('owner', async ({ rig, panel }) => {
    const before = remoteEventCount(rig);
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'block' });
    assert.equal(stub.inputRequests.length, 1);
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: '' });
    assert.equal(remoteEventCount(rig), before);
  });
});

test('a reason that looks like a key is refused with the secret sentence and nothing reaches the remote', async () => {
  await withBoard('owner', async ({ rig, panel, started }) => {
    const before = remoteEventCount(rig);
    stub.inputAnswers.push('use sk-abcdefghijklmnopqrstuvwxyz0123456789');
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'block' });
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'This text looks like a password or key, so it was not saved. Remove it and try again.' });
    assert.equal(remoteEventCount(rig), before);
    assert.equal(started.lines.some((line) => line.includes('sk-abcdefgh')), false, 'the output channel never carries the text');
  });
});

test('mark done always asks with a modal, and Not yet writes nothing', async () => {
  await withBoard('owner', async ({ rig, panel, started }) => {
    const before = remoteEventCount(rig);
    stub.messageAnswers.push('Not yet');
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'done' });
    assert.equal(stub.notifications[0]?.level, 'warn');
    assert.equal(stub.notifications[0]?.message, 'Mark 90-02 as done?');
    assert.deepEqual(stub.notificationActions[0], ['Mark done', 'Not yet']);
    assert.equal(stub.notificationOptions[0]?.modal, true);
    assert.equal(stub.notificationOptions[0]?.detail, 'Use this when the work is finished and merged. The whole team will see it as done, and plans that wait for it can become ready. You can reopen it later.');
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: '' });
    assert.equal(remoteEventCount(rig), before);

    stub.messageAnswers.push('Mark done');
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'done' });
    assert.equal(started.session.state().items.get(READY_PLAN)?.state, 'done');
    assert.equal(remoteEventCount(rig), before + 1);
  });
});

test('cancel asks a reason, then a modal only when other cards wait for it, and Keep item writes nothing', async () => {
  await withBoard('owner', async ({ rig, panel, started }) => {
    const before = remoteEventCount(rig);
    // plan:91.1-01 waits for plan:90-02, so cancelling 90-02 needs the second modal.
    stub.inputAnswers.push('replaced by another plan');
    stub.messageAnswers.push('Keep item');
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'cancel' });
    assert.equal(stub.inputRequests[0]?.title, 'Cancel 90-02');
    assert.equal(stub.inputRequests[0]?.prompt, 'Why is this being cancelled? The team will see your answer.');
    assert.equal(stub.inputRequests[0]?.placeHolder, 'For example: replaced by another plan');
    assert.equal(stub.notifications[0]?.message, 'Cancel 90-02?');
    assert.equal(stub.notificationOptions[0]?.detail, '1 plan waits for this card. It stays waiting until someone changes what it depends on. You can reopen this card later.');
    assert.deepEqual(stub.notificationActions[0], ['Cancel this item', 'Keep item']);
    assert.equal(remoteEventCount(rig), before, 'Keep item wrote nothing');

    stub.inputAnswers.push('replaced by another plan');
    stub.messageAnswers.push('Cancel this item');
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'cancel' });
    assert.equal(started.session.state().items.get(READY_PLAN)?.state, 'cancelled');

    // Nothing depends on the dependent plan, so its reason box alone is the confirmation.
    const modals = stub.notifications.length;
    stub.inputAnswers.push('not needed any more');
    await panel.receive({ type: 'move', itemId: DEPENDENT_PLAN, target: 'cancel' });
    assert.equal(stub.notifications.length, modals, 'no modal');
    assert.equal(started.session.state().items.get(DEPENDENT_PLAN)?.state, 'cancelled');
  });
});

test('moves that need no prompt show none: hold and release', async () => {
  await withBoard('owner', async ({ panel, started }) => {
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
    assert.equal(started.session.state().items.get(READY_PLAN)?.hold, true);
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'release' });
    assert.notEqual(started.session.state().items.get(READY_PLAN)?.hold, true);
    assert.equal(stub.inputRequests.length + stub.notifications.length, 0);
  });
});

test('adjacency: two members move the same card in the same poll window, one move lands and the other is told who got there first', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const owner = await startSession(rig, 'owner');
    const lead = await startSession(rig, rig.lead);
    const ownerBoard = openBoard(owner.session, new LiveTimers(), owner.lines);
    const leadBoard = openBoard(lead.session, new LiveTimers(), lead.lines);
    try {
      await ownerBoard.panel.receive({ type: 'ready' });
      await leadBoard.panel.receive({ type: 'ready' });
      assert.equal(cardOf(states(leadBoard.panel)[0], READY_PLAN)?.held, false);

      // The owner holds the card. The lead has not polled yet, so the lead's page still shows it ready.
      await ownerBoard.panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
      assert.equal(lead.session.state().items.get(READY_PLAN)?.hold, undefined, 'the lead window has not synced');
      const before = remoteEventCount(rig);

      await leadBoard.panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
      assert.deepEqual(lastOf(leadBoard.panel, 'refused'), {
        type: 'refused', itemId: READY_PLAN, reason: 'Owner Test already changed this card. The board now shows the latest. Nothing was moved.'
      });
      assert.equal(remoteEventCount(rig), before, 'exactly one move was accepted');
      const latest = states(leadBoard.panel).pop();
      assert.equal(cardOf(latest, READY_PLAN)?.held, true, 'the lead board shows the latest state');
      assert.equal(lead.session.state().items.get(READY_PLAN)?.hold, true);
    } finally {
      ownerBoard.board.controller.dispose();
      leadBoard.board.controller.dispose();
      owner.session.dispose();
      lead.session.dispose();
    }
  });
});

test('a card that changed while the prompt was open is reported as already changed, not as a bare refusal', async () => {
  await withBoard('owner', async ({ rig, panel, started }) => {
    const ownerLog = await openLog(rig, 'owner');
    // While the reason box is open, someone else blocks the card.
    stub.inputAnswers.push('my reason');
    const originalShow = (stub.vscode as { window: { showInputBox: (options?: unknown) => Promise<string | undefined> } }).window.showInputBox;
    (stub.vscode as { window: { showInputBox: unknown } }).window.showInputBox = async (options?: unknown): Promise<string | undefined> => {
      const answer = await originalShow(options);
      await ownerLog.log.append(() => [{ type: 'item.blocked', body: { id: READY_PLAN, reason: 'blocked by someone else' } }]);
      return answer;
    };
    try {
      await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'block' });
    } finally {
      (stub.vscode as { window: { showInputBox: unknown } }).window.showInputBox = originalShow;
    }
    const refused = lastOf(panel, 'refused');
    assert.ok(String(refused?.reason).endsWith('already changed this card. The board now shows the latest. Nothing was moved.'), String(refused?.reason));
    assert.equal(started.session.state().items.get(READY_PLAN)?.blocked?.reason, 'blocked by someone else');
  });
});

test('an append that fails offline gives the offline sentence, and the failure is written to the output channel', async () => {
  await withBoard('owner', async ({ rig, panel, started }) => {
    const away = `${rig.fixture.remote}.away`;
    renameSync(rig.fixture.remote, away);
    try {
      await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
    } finally {
      renameSync(away, rig.fixture.remote);
    }
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'The team remote could not be reached, so nothing was changed. Try again when you are back online.' });
    assert.ok(started.lines.some((line) => line.startsWith('Team Board:')), 'the failure is in the output channel');
    assert.equal(started.lines.some((line) => line.includes('Alpha') || line.includes('90-02')), false, 'and carries no card text');
  });
});

test('a secret caught on write maps to the secret sentence and a lost device key to the read-only sentence', async () => {
  await withBoard('owner', async ({ started, ui }) => {
    const { SecretLeakError } = require('../domain/team/secrets') as typeof import('../domain/team/secrets');
    const { NoDeviceKeyError } = require('../team/eventLog') as typeof import('../team/eventLog');
    for (const [thrown, expected] of [
      [new SecretLeakError('leak', ['body.reason']), 'This text looks like a password or key, so it was not saved. Remove it and try again.'],
      [new NoDeviceKeyError(), 'This computer has no device key for this team, so it can read the team log but not write to it.']
    ] as const) {
      const session = new Proxy(started.session, {
        get(target, property) {
          if (property === 'currentLog') return () => ({ append: async (): Promise<never> => { throw thrown; } });
          const value = Reflect.get(target, property) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      });
      const { panel, board } = openBoard(session, ui, started.lines);
      try {
        await panel.receive({ type: 'ready' });
        await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
        assert.equal((lastOf(panel, 'refused') as { reason?: string } | undefined)?.reason, expected);
      } finally {
        board.controller.dispose();
      }
    }
  });
});

test('a developer cannot move a card and is told so before any prompt; a window with no device key is told that instead', async () => {
  await withBoard('dev', async ({ rig, panel }) => {
    const before = remoteEventCount(rig);
    for (const target of ['hold', 'block', 'done'] as const) {
      await panel.receive({ type: 'move', itemId: READY_PLAN, target });
      assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'Only the team owner or a lead can move cards. Nothing was moved.' });
    }
    assert.equal(stub.inputRequests.length + stub.notifications.length, 0, 'no prompt was shown');
    assert.equal(remoteEventCount(rig), before);
  });
  const { MemorySecrets } = require('./helpers/teamHarness') as typeof import('./helpers/teamHarness');
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const keyless = await startSession(rig, { ...rig.lead, secrets: new MemorySecrets() });
    const { panel, board } = openBoard(keyless.session, new LiveTimers(), keyless.lines);
    try {
      await panel.receive({ type: 'ready' });
      await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
      assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'This computer has no device key for this team, so it can read the team log but not write to it.' });
      assert.equal(stub.inputRequests.length + stub.notifications.length, 0);
    } finally {
      board.controller.dispose();
      keyless.session.dispose();
    }
  });
});

test('a card that is not on the board is refused, and no session at all is explained, without a throw', async () => {
  await withBoard('owner', async ({ panel, board }) => {
    await panel.receive({ type: 'move', itemId: 'plan:99-99', target: 'hold' });
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: 'plan:99-99', reason: 'This card is no longer on the board. Nothing was moved.' });
    await panel.receive({ type: 'detail', itemId: 'plan:99-99' });
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: 'plan:99-99', reason: 'This card is no longer on the board. Nothing was moved.' });
    const lines: string[] = [];
    const idle = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, { session: () => undefined, output: { appendLine: (line) => { lines.push(line); }, show: () => undefined }, timers: new LiveTimers() });
    idle.openPanel();
    const idlePanel = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    await idlePanel.receive({ type: 'ready' });
    await idlePanel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
    assert.equal(states(idlePanel).length, 0, 'there is no model to send');
    assert.equal((lastOf(idlePanel, 'refused') as { reason?: string } | undefined)?.reason, 'The Team Board is not ready yet. Nothing was moved.');
    idle.controller.dispose();
    board.controller.dispose();
  });
});

test('detail posts the card with its history in plain sentences', async () => {
  await withBoard('owner', async ({ panel }) => {
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
    await panel.receive({ type: 'detail', itemId: READY_PLAN });
    const detail = lastOf(panel, 'detail') as { itemId?: string; displayId?: string; history?: Array<{ text: string }>; facts?: unknown } | undefined;
    assert.equal(detail?.itemId, READY_PLAN);
    assert.equal(detail?.displayId, '90-02');
    assert.ok(detail?.facts !== undefined);
    const texts = detail?.history?.map((entry) => entry.text) ?? [];
    assert.equal(texts[0], 'Owner Test put this on hold.');
    assert.equal(texts[texts.length - 1], 'Import added this to the board.');
  });
});

// ---- visibility and posting ------------------------------------------------------------------------------------------------------------------

test('a hidden surface gets nothing, the session is told only when no surface is visible, and showing it brings it up to date once', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const calls: boolean[] = [];
    const original = a.session.setBoardVisible.bind(a.session);
    a.session.setBoardVisible = (visible: boolean): void => { calls.push(visible); original(visible); };
    const ui = new LiveTimers();
    const { panel, board } = openBoard(a.session, ui, a.lines);
    try {
      await panel.receive({ type: 'ready' });
      const { view, record } = stub.createWebviewView();
      stub.viewProviders[0]?.provider.resolveWebviewView(view);
      await record.receive({ type: 'ready' });
      assert.deepEqual(calls, [true], 'told once that the board can be seen');

      panel.setVisible(false);
      assert.deepEqual(calls, [true], 'the sidebar view is still visible');
      record.setVisible(false);
      assert.deepEqual(calls, [true, false], 'told when nothing can be seen');

      const sentBefore = states(panel).length;
      const owner = await openLog(rig, 'owner');
      await owner.log.append(() => [{ type: 'item.blocked', body: { id: READY_PLAN, reason: WAITING_FOR_KEY } }]);
      a.timers.fire();
      await until(() => a.session.state().items.get(READY_PLAN)?.blocked !== undefined, 'the poll to bring the block');
      assert.equal(ui.live.length, 0, 'no post is scheduled for a hidden board');
      assert.equal(states(panel).length, sentBefore, 'nothing was posted while hidden');
      assert.equal(panel.postedWhileHidden + record.postedWhileHidden, 0);

      panel.setVisible(true);
      assert.deepEqual(calls, [true, false, true]);
      assert.equal(states(panel).length, sentBefore + 1, 'one post brings it up to date');
      assert.equal(cardOf(states(panel).pop(), READY_PLAN)?.column, 'backlog');
      panel.setVisible(false);
      panel.setVisible(true);
      assert.equal(states(panel).length, sentBefore + 1, 'nothing changed, so nothing is sent again');
      // The page can also say it is hidden or shown.
      await panel.receive({ type: 'visible', value: false });
      assert.equal(calls[calls.length - 1], false);
      await panel.receive({ type: 'visible', value: true });
      assert.equal(calls[calls.length - 1], true);
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
  });
});

test('posts are throttled to four a second and only when the model changed', async () => {
  await withBoard('owner', async ({ panel, started, ui }) => {
    assert.equal(states(panel).length, 1);
    // A poll that brings nothing new posts nothing.
    started.timers.fire();
    await until(() => started.timers.live.length === 1, 'the next poll to be armed');
    assert.equal(ui.live.length, 0);
    assert.equal(states(panel).length, 1);

    // Two changes inside one throttle window make one post carrying both.
    await started.session.currentLog().append(() => [{ type: 'item.updated', body: { id: READY_PLAN, changes: { hold: true } } }]);
    await started.session.currentLog().append(() => [{ type: 'item.blocked', body: { id: DEPENDENT_PLAN, reason: WAITING_FOR_KEY } }]);
    assert.equal(states(panel).length, 1, 'held back until the throttle is up');
    assert.deepEqual(ui.delays(), [250], 'one timer for 250 ms, not one per change');
    ui.fire();
    assert.equal(states(panel).length, 2);
    const latest = states(panel)[1];
    assert.equal(cardOf(latest, READY_PLAN)?.held, true);
    assert.equal(cardOf(latest, DEPENDENT_PLAN)?.column, 'backlog');

    // Time passes beyond the throttle: the next change posts at once.
    ui.clock += 1000;
    await started.session.currentLog().append(() => [{ type: 'item.unblocked', body: { id: DEPENDENT_PLAN } }]);
    assert.equal(states(panel).length, 3, 'posted immediately');
    assert.equal(ui.live.length, 0);
  });
});

test('hostile messages from a page are ignored or refused and never reach the log', async () => {
  await withBoard('dev', async ({ rig, panel, started }) => {
    const before = remoteEventCount(rig);
    const postedBefore = panel.posted.length;
    const hostile: unknown[] = [
      { type: 'move', itemId: READY_PLAN, target: 'delete' }, { type: 'move', itemId: 'x'.repeat(500), target: 'hold' }, JSON.parse('{"type":"move","itemId":"plan:90-02","target":"hold","__proto__":{"role":"owner"}}'),
      { type: 'set-role', role: 'owner' }, 'move', 42, null, [], { type: 'new-item', draft: { kind: 'bug', title: 't'.repeat(201), scope: [] } },
      { type: 'move', itemId: READY_PLAN, target: 'hold', role: 'owner' }, { type: 'move', itemId: READY_PLAN, target: 'hold', viewer: 'owner' }
    ];
    for (const message of hostile) await panel.receive(message);
    assert.equal(panel.posted.length, postedBefore, 'ignored messages get no answer at all');
    assert.equal(remoteEventCount(rig), before);
    assert.equal(stub.inputRequests.length + stub.notifications.length, 0);
    assert.equal(started.session.state().items.get(READY_PLAN)?.hold, undefined);
    // A legal move from the developer's page is refused by the host from the log's roster, whatever the page believes.
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
    assert.equal((lastOf(panel, 'refused') as { reason?: string } | undefined)?.reason, 'Only the team owner or a lead can move cards. Nothing was moved.');
    assert.equal(remoteEventCount(rig), before);
  });
});

test('the page can ask for the import, the panel, a retry and the output channel', async () => {
  await withBoard('owner', async ({ panel, started }) => {
    const ran: Array<{ id: string; args: unknown[] }> = [];
    for (const id of ['nearAi.team.importPlans', 'nearAi.team.openBoard']) stub.commands.set(id, (...args: unknown[]) => { ran.push({ id, args }); });
    let nudged = 0;
    const originalNudge = started.session.nudge.bind(started.session);
    started.session.nudge = (): void => { nudged += 1; originalNudge(); };
    let shown = 0;
    const board = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, { session: () => started.session, output: { appendLine: () => undefined, show: () => { shown += 1; } }, timers: new LiveTimers() });
    board.openPanel();
    const second = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    try {
      await second.receive({ type: 'import-plans' });
      await second.receive({ type: 'open-board' });
      await second.receive({ type: 'retry' });
      await second.receive({ type: 'show-details' });
      assert.deepEqual(ran, [{ id: 'nearAi.team.importPlans', args: [{ milestone: 'current' }] }, { id: 'nearAi.team.openBoard', args: [] }]);
      assert.equal(nudged, 1);
      assert.equal(shown, 1);
      assert.ok(panel.posted.length > 0);
    } finally {
      board.controller.dispose();
    }
  });
});

// ---- the commands in a team project ----------------------------------------------------------------------------------------------------------

const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const importModule = require('../team/importPlans') as typeof import('../team/importPlans');
const setContexts = (): Array<{ command: string; args: unknown[] }> => stub.externalCommands.filter((entry) => entry.command === 'setContext');

test('team project: the board comes up once the session starts, Open Team Board opens one panel and reveals it again, and the context key follows the window', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    stub.setWorkspaceFolders([rootOf(rig, 'a')]);
    const context = createFakeContext(rig.owner.globalStorageDir, rig.owner.secrets);
    const handle = commandsModule.registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    try {
      assert.equal(await handle.ready, 'team');
      assert.deepEqual(setContexts(), [{ command: 'setContext', args: ['nearAi.teamMode', true] }], 'the context key is set once the session runs');
      assert.equal(stub.viewProviders.length, 1, 'the view provider is registered once');
      assert.equal(stub.webviewPanels.length, 0, 'no panel until someone asks');

      await stub.commands.get(commandsModule.OPEN_BOARD_COMMAND)?.();
      assert.equal(stub.webviewPanels.length, 1);
      assert.equal(stub.webviewPanels[0]?.viewType, 'nearAiTeamBoard');
      await stub.commands.get(commandsModule.OPEN_BOARD_COMMAND)?.();
      assert.equal(stub.webviewPanels.length, 1, 'a second run reveals the open panel');
      assert.equal(stub.webviewPanels[0]?.revealCalls, 1);
      assert.equal(stub.viewProviders.length, 1, 'still one provider');
      assert.equal(setContexts().length, 1, 'the key was not set again');
      assert.deepEqual(stub.notifications.filter((entry) => /solo|Team Mode is not on/.test(entry.message)), [], 'no solo explanation appeared');

      // The panel shows this window's session: ready, then the model.
      await stub.webviewPanels[0]?.receive({ type: 'ready' });
      assert.equal(cardOf(states(stub.webviewPanels[0] as RecordedWebviewPanel)[0], READY_PLAN)?.column, 'ready');
    } finally {
      for (const subscription of context.subscriptions) subscription.dispose();
    }
    assert.deepEqual(setContexts()[setContexts().length - 1], { command: 'setContext', args: ['nearAi.teamMode', false] }, 'the key is cleared when the window closes');
  });
});

test('Import Plans to Team Board: a palette run with two milestones asks first with the current one recommended, runs under a progress and reports the sentence', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    stub.setWorkspaceFolders([rootOf(rig, 'a')]);
    const context = createFakeContext(rig.owner.globalStorageDir, rig.owner.secrets);
    const handle = commandsModule.registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    try {
      assert.equal(await handle.ready, 'team');
      const milestones = await importModule.listImportableMilestones({ projectRoot: rootOf(rig, 'a'), remote: 'origin', branch: 'main' });
      assert.equal(milestones.length, 2, 'the fixture roadmap has two milestones');
      const current = milestones[0] as NonNullable<typeof milestones[number]>;
      assert.equal(current.current, true);

      stub.notifications.length = 0;
      stub.quickPickAnswers.push(current.title);
      await stub.commands.get(commandsModule.IMPORT_PLANS_COMMAND)?.();
      assert.equal(stub.quickPickRequests.length, 1);
      assert.equal(stub.quickPickRequests[0]?.labels[0], current.title, 'the current milestone is first, so Enter imports it');
      assert.match(stub.quickPickRequests[0]?.descriptions[0] ?? '', /Recommended/);
      assert.deepEqual(stub.progress.map((entry) => [entry.title, entry.cancellable]), [['Importing plans to the Team Board', false]]);
      const sentence = stub.notifications[stub.notifications.length - 1];
      assert.ok(sentence !== undefined && sentence.level === 'info', 'a success is information');
      assert.match(sentence.message, /^(Imported \d+ items? to the Team Board\.|The Team Board is already up to date\.)/);

      // The page's argument names the current milestone, so there is nothing to ask.
      stub.notifications.length = 0;
      await stub.commands.get(commandsModule.IMPORT_PLANS_COMMAND)?.({ milestone: 'current' });
      assert.equal(stub.quickPickRequests.length, 1, 'no second pick');
      assert.equal(stub.progress.length, 2);
      assert.equal(stub.notifications[stub.notifications.length - 1]?.message, 'The Team Board is already up to date.');

      // A dismissed pick is a quiet cancel.
      stub.notifications.length = 0;
      await stub.commands.get(commandsModule.IMPORT_PLANS_COMMAND)?.();
      assert.equal(stub.quickPickRequests.length, 2);
      assert.equal(stub.progress.length, 2, 'nothing ran');
      assert.deepEqual(stub.notifications, []);
    } finally {
      for (const subscription of context.subscriptions) subscription.dispose();
    }
  });
});

test('Import Plans to Team Board by a developer reports the reason in plain words and changes nothing', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    stub.setWorkspaceFolders([rootOf(rig, 'b')]);
    const context = createFakeContext(rig.dev.globalStorageDir, rig.dev.secrets);
    const handle = commandsModule.registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    try {
      assert.equal(await handle.ready, 'team');
      const before = remoteEventCount(rig);
      stub.notifications.length = 0;
      await stub.commands.get(commandsModule.IMPORT_PLANS_COMMAND)?.({ milestone: 'current' });
      const last = stub.notifications[stub.notifications.length - 1];
      assert.ok(last !== undefined);
      assert.equal(last.level, 'error');
      assert.equal(last.message, 'The import did not finish: not permitted: only the team owner and leads can import plans. Nothing was changed.');
      assert.equal(remoteEventCount(rig), before, 'nothing was written');
    } finally {
      for (const subscription of context.subscriptions) subscription.dispose();
    }
  });
});

// ---- memory ----------------------------------------------------------------------------------------------------------------------------------

// The board lives as long as the extension, and a window replaces its session after a join or a NEAR link (restartSession in teamCommands), so a
// replaced session must not stay reachable from the board, a vscode listener or a pending poll timer, or a long-running window keeps every session it
// ever had. This file once died at its 18th test under the 6 GB address-space cap; that was V8's wasm reservation (helpers/addressSpace.ts), not a
// leak, and this test keeps it that way. The session polls on real (unref'd) timers here, so a poll timer left armed after dispose would hold it.
const realTimers = {
  now: (): number => performance.now(),
  set: (callback: () => void, ms: number): unknown => setTimeout(callback, ms).unref(),
  clear: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
};

test('a replaced session is released while the board stays open: no board subscription, listener or poll timer keeps it', async () => {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    let current: Session | undefined;
    const lines: string[] = [];
    const board = registerTeamBoard(createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {}) as never, {
      session: () => current, output: { appendLine: (line) => { lines.push(line); }, show: () => undefined }, timers: new LiveTimers()
    });
    board.openPanel();
    const panel = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    try {
      // In its own function, so no variable of this test holds the first session once it is replaced.
      const replaced = await (async (): Promise<WeakRef<Session>> => {
        const first = await startSession(rig, 'owner', { timers: realTimers });
        current = first.session;
        board.controller.sessionChanged();
        await panel.receive({ type: 'ready' });
        await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
        await panel.receive({ type: 'detail', itemId: READY_PLAN });
        assert.equal(lastOf(panel, 'refused'), undefined);
        return new WeakRef(first.session);
      })();

      // The window replaces it the way restartSession does: dispose the old one, start a fresh one, and the board follows.
      replaced.deref()?.dispose();
      current = undefined;
      const second = await startSession(rig, 'owner', { timers: realTimers });
      current = second.session;
      board.controller.sessionChanged();
      assert.equal(cardOf(states(panel).pop(), READY_PLAN)?.held, true, 'the board shows the new session');

      await turn();
      collect();
      // Compared as a boolean: a failing strict assert prints its operands in full, and a live session is far too large to print.
      assert.equal(replaced.deref() === undefined, true, 'the replaced session was released');
    } finally {
      board.controller.dispose();
      current?.dispose();
    }
  });
});
