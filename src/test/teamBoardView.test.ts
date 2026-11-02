// The Team Board host (Phase 62 plan 08): the panel and the view provider on a real team session over real clones, the page protocol, the nonce CSP,
// the message parser, throttled posting and the native prompts of a move. Timers of the session and of the board's own throttle fire by hand; git,
// the log and the roster are real. Lazy requires keep every vscode import behind the stub.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { importPlans } from '../team/importPlans';
import { openLog, rootOf, storageOf } from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { LiveTimers, until, withLiveTeam } from './helpers/teamLiveRig';
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
  await until(() => timers.live.length === 1, 'the first poll to be armed');
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
