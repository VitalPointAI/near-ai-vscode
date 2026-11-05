// The Team Board host (Phase 62 plan 08): the editor panel on a real team session over real clones, the page protocol, the nonce CSP,
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
const { BOARD_PANEL_TYPE, BOARD_SCRIPTS, BOARD_STYLES, BOARD_TEST_SCRIPTS, boardHtml, boardTap, parseBoardMessage, registerTeamBoard } = boardModule;
type BoardSurface = import('../services/team/boardView').BoardSurface;
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

// The board has one editor tab, but the controller serves any number of pages. These tests attach a second, hand-made page to check that a hidden
// page gets nothing and that the session hears "hidden" only when no page can be seen.
function secondPage(board: ReturnType<typeof registerTeamBoard>): RecordedWebview {
  const { view, record } = stub.createWebviewView();
  const page = view as { webview: BoardSurface['webview']; visible: boolean; onDidChangeVisibility(listener: () => void): { dispose(): void }; onDidDispose(listener: () => void): { dispose(): void } };
  board.controller.attach({
    kind: 'panel', webview: page.webview, isVisible: () => page.visible,
    onDidChangeVisibility: (listener) => page.onDidChangeVisibility(() => { listener(page.visible); }), onDidDispose: (listener) => page.onDidDispose(listener)
  });
  return record;
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
  boardTap.layout = undefined;
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

// 62.1-01 (D-02, D-03): every state the host posts carries the timeline of the same board, and the board model itself is what it always was.
const TIMELINE_NOW = Date.parse('2026-03-05T12:00:00.000Z');
interface TimelineState { type: 'state'; model: Record<string, unknown> & { cards: Array<Record<string, unknown> & { id: string }>; timeline?: { dots: Array<{ cardId: string }>; edges: Array<{ from: string; to: string }> } } }
const plainJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

function withoutTimeline(model: TimelineState['model']): unknown {
  const { timeline: _timeline, timelineProblem: _problem, ...rest } = model;
  return plainJson({ ...rest, cards: model.cards.map(({ finishedText: _finished, ...card }) => card) });
}

function baseModelOf(session: Session, status: { kind: string }): unknown {
  const viewerId = session.memberId();
  const open = status.kind === 'live' || status.kind === 'syncing';
  const { buildBoardModel } = require('../domain/team/board') as typeof import('../domain/team/board');
  return plainJson(buildBoardModel(session.state(), {
    nowMs: TIMELINE_NOW, status: status as Parameters<typeof buildBoardModel>[1]['status'], canWrite: session.canWrite() && open, ...(viewerId === undefined ? {} : { viewerId })
  }));
}

test('62.1-01: the first posted state carries a timeline with one dot per card and the edges, and the rest is exactly the board model', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
    const board = registerTeamBoard(context as never, {
      session: () => a.session, output: { appendLine: (line) => { a.lines.push(line); }, show: () => undefined }, timers: new LiveTimers(), nowMs: () => TIMELINE_NOW
    });
    board.openPanel();
    const panel = stub.webviewPanels[stub.webviewPanels.length - 1];
    assert.ok(panel !== undefined, 'a panel was created');
    try {
      await panel.receive({ type: 'ready' });
      const first = panel.posted.find((message): message is TimelineState => (message as { type?: string }).type === 'state');
      assert.ok(first !== undefined, 'the first state message arrived');
      const timeline = first.model.timeline;
      assert.ok(timeline !== undefined, 'the posted model carries the timeline');
      assert.deepEqual(timeline.dots.map((dot) => dot.cardId).sort(), first.model.cards.map((card) => card.id).sort(), 'exactly one dot per card of the board');
      // Every dependency of a card on another card (not a whole phase) is an edge, and nothing else is.
      const onBoard = new Set(first.model.cards.map((card) => card.id));
      const items = a.session.state().items;
      const expected = [...onBoard].flatMap((id) => (items.get(id)?.dependsOn ?? [])
        .filter((from) => from !== id && onBoard.has(from) && items.get(from)?.kind !== 'phase').map((from) => `${from} > ${id}`)).sort();
      assert.ok(expected.includes(`plan:90-01 > ${READY_PLAN}`), 'the fixture has its dependency between two plans');
      assert.deepEqual(timeline.edges.map((edge) => `${edge.from} > ${edge.to}`).sort(), expected, 'one edge per dependency between two cards');
      assert.equal(first.model.timelineProblem, undefined);
      assert.deepEqual(withoutTimeline(first.model), baseModelOf(a.session, first.model.status as { kind: string }), 'without the timeline the posted model is buildBoardModel\'s');
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
  });
});

// 62.1-01 (D-01): a done card says when it was finished only when its history holds the mark done; nothing else about time reaches the timeline.
test('62.1-01: a plan marked done on the board carries the local date of that mark done; an imported done plan and open cards carry none', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const lead = await startSession(rig, rig.lead);
    const ui = new LiveTimers();
    const { panel, board } = openBoard(lead.session, ui, lead.lines);
    try {
      await panel.receive({ type: 'ready' });
      const latest = (): TimelineState | undefined => panel.posted.filter((message): message is TimelineState => (message as { type?: string }).type === 'state').at(-1);
      assert.ok(latest()?.model.cards.every((card) => card.finishedText === undefined), 'before any mark done no card has a finish date');
      stub.messageAnswers.push('Mark done');
      await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'done' });
      assert.equal(lead.session.state().items.get(READY_PLAN)?.state, 'done');
      await until(() => {
        if (ui.live.length > 0) ui.fire();
        return latest()?.model.cards.find((card) => card.id === READY_PLAN)?.column === 'done';
      }, 'the state with the plan in Done');
      const markDone = lead.session.itemHistory(READY_PLAN).find((entry) => entry.type === 'item.updated' && entry.changed?.includes('state') === true);
      assert.ok(markDone !== undefined, 'the history holds the mark done');
      const cards = latest()?.model.cards ?? [];
      const expected = new Date(markDone.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      assert.equal(cards.find((card) => card.id === READY_PLAN)?.finishedText, expected);
      assert.equal(cards.find((card) => card.id === 'plan:90-01')?.column, 'done', 'the fixture imports 90-01 already done');
      assert.equal(cards.find((card) => card.id === 'plan:90-01')?.finishedText, undefined, 'an imported done plan has no finish date');
      for (const card of cards.filter((entry) => entry.column !== 'done')) assert.equal(card.finishedText, undefined, `${card.id} is not done`);
    } finally {
      board.controller.dispose();
      lead.session.dispose();
    }
  });
});

// 62.1-01 (UI-SPEC "States": the timeline could not be drawn): a layout that throws leaves Columns working and logs one line without card text.
test('62.1-01: when the layout throws, the state has no timeline and timelineProblem, its cards are the board model\'s, and one redacted line is logged', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const titles = [...a.session.state().items.values()].map((item) => item.title).filter((title) => title.length > 3);
    assert.ok(titles.length > 0);
    const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
    const thrower = (): never => { throw new Error(`cannot place ${titles.join(', ')}`); };
    const deps = {
      session: () => a.session, output: { appendLine: (line: string) => { a.lines.push(line); }, show: () => undefined }, timers: new LiveTimers(), nowMs: () => TIMELINE_NOW,
      buildTimeline: thrower
    } as Parameters<typeof registerTeamBoard>[1];
    const board = registerTeamBoard(context as never, deps);
    board.openPanel();
    const panel = stub.webviewPanels[stub.webviewPanels.length - 1];
    assert.ok(panel !== undefined, 'a panel was created');
    try {
      await panel.receive({ type: 'ready' });
      const first = panel.posted.find((message): message is TimelineState => (message as { type?: string }).type === 'state');
      assert.ok(first !== undefined, 'the board state still arrived');
      assert.equal(first.model.timeline, undefined, 'no timeline');
      assert.equal(first.model.timelineProblem, true);
      assert.deepEqual(plainJson(first.model.cards), (baseModelOf(a.session, first.model.status as { kind: string }) as { cards: unknown }).cards, 'Columns still has every card as before');
      const failures = a.lines.filter((line) => line.startsWith('Team Board: the timeline could not be drawn:'));
      assert.equal(failures.length, 1, 'one line in the NEAR AI Team output');
      for (const title of titles) assert.ok(!(failures[0] ?? '').includes(title), 'the line holds no card text');
      assert.ok(!a.lines.some((line) => line.startsWith('Team Board: the board could not be updated')), 'the board itself did not fail');
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

// Owner decision 2026-11-03 (G-62-1, amends D-15 and AD-22): the full board opens only in its own editor tab, and nothing opens by itself. This
// replaces the test that asserted the sidebar view provider: no view provider is ever registered, and no page exists until someone asks.
test('no view provider is ever registered, and a lead session that syncs and imports opens nothing until the board is asked for (G-62-1)', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    const lead = await startSession(rig, rig.lead);
    const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
    const board = registerTeamBoard(context as never, { session: () => lead.session, output: { appendLine: (line) => { lead.lines.push(line); }, show: () => undefined }, timers: new LiveTimers() });
    try {
      assert.equal(stub.viewProviders.length, 0, 'no sidebar view provider');
      assert.equal(stub.webviewPanels.length, 0, 'no panel when the board is registered');
      await importFixture(rig);
      lead.timers.fire();
      await until(() => lead.session.state().items.get(READY_PLAN) !== undefined, 'the poll to bring the imported plans');
      assert.equal(stub.webviewPanels.length, 0, 'still no panel after the session synced the import');
      assert.equal(stub.viewProviders.length, 0, 'and still no view provider');
      board.openPanel();
      assert.equal(stub.webviewPanels.length, 1, 'asking opens one panel');
      assert.equal(stub.webviewPanels[0]?.viewType, BOARD_PANEL_TYPE);
      board.openPanel();
      assert.equal(stub.webviewPanels.length, 1, 'asking again opens no second panel');
      assert.equal(stub.webviewPanels[0]?.revealCalls, 1, 'it reveals the first');
      assert.equal(stub.viewProviders.length, 0);
    } finally {
      board.controller.dispose();
      lead.session.dispose();
    }
  });
});

test('the page has one nonce CSP, one script tag per client file in order and no inline script, style, remote address or font source', () => {
  const uri = stub.vscode as { Uri: { file(path: string): { fsPath: string } } };
  const media = uri.Uri.file(MEDIA_BOARD);
  const webview = { cspSource: 'CSP_SOURCE', asWebviewUri: (value: { fsPath: string }) => ({ toString: () => `webview://${value.fsPath}` }) };
  // The page is written for one place, the editor tab, so boardHtml takes no surface and the body carries no surface attribute (G-62-1).
  for (const testSeams of [false, true]) {
    const html = boardHtml(webview as never, media as never, 'NONCE', testSeams);
    assert.equal(html.match(/<meta http-equiv="Content-Security-Policy"/g)?.length, 1, 'one CSP meta');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    assert.equal(csp, "default-src 'none'; style-src CSP_SOURCE; script-src 'nonce-NONCE';");
    // 62-21 (T-62-68): the test-only layout probe is the last script, and only on a page made for the extension-host tests.
    const files: readonly string[] = testSeams ? [...BOARD_SCRIPTS, ...BOARD_TEST_SCRIPTS] : BOARD_SCRIPTS;
    const scripts = [...html.matchAll(/<script\b([^>]*)>([^<]*)<\/script>/g)];
    assert.equal(scripts.length, files.length, 'one script tag per client file');
    assert.equal((html.match(/<script\b/g) ?? []).length, files.length, 'no script tag the pattern missed');
    scripts.forEach((script, index) => {
      assert.ok((script[1] ?? '').includes('nonce="NONCE"'), 'each script carries the nonce');
      assert.ok((script[1] ?? '').includes(`src="webview://${MEDIA_BOARD}/${files[index]}"`), `script ${index} is ${files[index]}`);
      assert.equal(script[2], '', 'no inline script body');
    });
    assert.equal(html.includes('layout-probe'), testSeams, 'the layout probe tag only on a test page');
    if (testSeams) assert.match(scripts.at(-1)?.[1] ?? '', /nonce="NONCE" src="webview:\/\/[^"]*\/layout-probe\.js"/, 'the probe is the last script and nonce-bound');
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    assert.equal(links.length, BOARD_STYLES.length);
    BOARD_STYLES.forEach((file, index) => { assert.ok((links[index]?.[0] ?? '').includes(`href="webview://${MEDIA_BOARD}/${file}"`)); });
    assert.equal(/\sstyle\s*=/.test(html), false, 'no inline style attribute');
    assert.equal(/<style\b/.test(html), false, 'no style element');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no inline event handler');
    assert.equal(/https?:/.test(html), false, 'no remote address');
    assert.equal(html.includes('font-src'), false, 'icons are inline SVG, so no font source');
    assert.ok(html.includes('id="root"') && html.includes('id="live"'), 'the root and the live region the client expects');
    assert.equal(html.includes('data-surface'), false, 'no surface attribute on the body');
    assert.equal(html.includes('data-e2e="1"'), testSeams, 'the test mark only when asked for');
  }
});

test('host-request reaches the visible pages and nothing that is hidden, and exists only under the extension-host tests (IN-05)', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const plain = openBoard(a.session, new LiveTimers(), a.lines);
    assert.equal(boardTap.request === undefined, true, 'a normal board offers no request hook');
    assert.equal(boardTap.probe === undefined, true, 'and no page probe');
    assert.equal(plain.panel.html.includes('data-e2e'), false, 'and does not mark its page for the tests');
    plain.board.controller.dispose();
    const board = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, { session: () => a.session, output: { appendLine: (line) => { a.lines.push(line); }, show: () => undefined }, timers: new LiveTimers(), testSeams: true });
    board.openPanel();
    const panel = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    try {
      assert.equal(panel.html.includes('data-e2e="1"'), true, 'the test board marks its page');
      const record = secondPage(board);
      record.setVisible(false);
      assert.ok(boardTap.request !== undefined, 'the controller offers the request hook');
      await boardTap.request?.({ type: 'retry' });
      assert.deepEqual(panel.posted.filter((message) => (message as { type?: string }).type === 'host-request'), [{ type: 'host-request', payload: { type: 'retry' } }]);
      assert.equal(record.posted.length, 0, 'the hidden page got nothing');
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

test('the layout hook exists only under the extension-host tests and asks only the visible page to measure itself (62-21, T-62-68)', async () => {
  resetStub();
  assert.deepEqual([...BOARD_TEST_SCRIPTS], ['layout-probe.js']);
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const plain = openBoard(a.session, new LiveTimers(), a.lines);
    assert.equal(boardTap.layout === undefined, true, 'a normal board offers no layout hook');
    assert.equal(plain.panel.html.includes('layout-probe'), false, 'and loads no probe');
    plain.board.controller.dispose();
    const board = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, { session: () => a.session, output: { appendLine: (line) => { a.lines.push(line); }, show: () => undefined }, timers: new LiveTimers(), testSeams: true });
    board.openPanel();
    const panel = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    const layouts = (record: RecordedWebview): unknown[] => record.posted.filter((message) => (message as { type?: string }).type === 'e2e-layout');
    try {
      assert.equal(panel.html.includes('layout-probe.js'), true, 'the test board loads the probe');
      const record = secondPage(board);
      record.setVisible(false);
      assert.ok(boardTap.layout !== undefined, 'the controller offers the layout hook');
      await boardTap.layout?.({ id: 3, action: 'scroll', top: 400 });
      assert.deepEqual(layouts(panel), [{ type: 'e2e-layout', id: 3, action: 'scroll', top: 400 }]);
      assert.equal(layouts(record).length, 0, 'the hidden page got nothing');
      panel.setVisible(false);
      await boardTap.layout?.({ id: 4, action: 'measure' });
      assert.equal(layouts(panel).length, 1, 'a hidden panel gets nothing either');
    } finally {
      board.controller.dispose();
      a.session.dispose();
    }
    assert.equal(boardTap.layout === undefined, true, 'the hook goes with the controller');
  });
});

// 62.1-08 (T-62.1-17): the real-window test draws the timeline's rare states (a loop, a finished milestone, a stack over the cap, a failed layout) on
// this repository's roadmap through boardTap.shape. It is read only when the controller has its test seams (NEAR_AI_E2E=1), it works on a copy of
// the state, and the layout failure is the 62.1-01 path. "Draw the timeline again" posts retry, which must bring the timeline back even when no
// event arrived, so a retry also sends the page the model again when it changed.
test('62.1-08: the shape seam reshapes a copy of the state for both builds or fails the layout, only under the extension-host tests, and a retry draws the timeline again', async () => {
  resetStub();
  const tap = boardTap as Record<string, unknown>;
  type Posted = { type: 'state'; model: { cards: Array<{ id: string }>; timeline?: { dots: Array<{ cardId: string }> }; timelineProblem?: boolean } };
  const posted = (record: RecordedWebview): Posted[] => record.posted.filter((m): m is Posted => (m as { type?: string }).type === 'state');
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    const EXTRA = 'plan:90-77';
    const shape = (state: import('../domain/team/types').TeamState): import('../domain/team/types').TeamState => {
      const base = state.items.get(READY_PLAN)!;
      state.items.set(EXTRA, { ...base, id: EXTRA, title: 'A plan only the seam adds', gsd: { ...base.gsd!, plan: '77' }, dependsOn: [] });
      return state;
    };
    const output = { appendLine: (line: string) => { a.lines.push(line); }, show: () => undefined };
    tap.shape = { state: shape, failTimeline: true };
    try {
      // A normal board never reads the seam.
      const plain = openBoard(a.session, new LiveTimers(), a.lines);
      await plain.panel.receive({ type: 'ready' });
      const first = posted(plain.panel)[0]!;
      assert.equal(first.model.cards.some((c) => c.id === EXTRA), false, 'a normal board is not reshaped');
      assert.ok(first.model.timeline !== undefined && first.model.timelineProblem === undefined, 'nor is its layout failed');
      plain.board.controller.dispose();

      const board = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, {
        session: () => a.session, output, timers: new LiveTimers(), testSeams: true, requestLimits: { coolDownMs: 0, writeBurst: 10, writeRefillMs: 500 }
      });
      tap.shape = { state: shape };
      board.openPanel();
      const panel = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
      try {
        await panel.receive({ type: 'ready' });
        const shaped = posted(panel).at(-1)!;
        assert.ok(shaped.model.cards.some((c) => c.id === EXTRA), 'the board model is built from the shaped state');
        assert.ok(shaped.model.timeline?.dots.some((d) => d.cardId === EXTRA), 'and so is the timeline');
        assert.equal(a.session.state().items.has(EXTRA), false, 'the session\'s own state is never changed');
        // The layout fails: the 62.1-01 path (no timeline, the flag, one line in the output).
        tap.shape = { failTimeline: true };
        await panel.receive({ type: 'retry' });
        const failed = posted(panel).at(-1)!;
        assert.equal(failed.model.timelineProblem, true, 'a retry sends the failed layout');
        assert.equal(failed.model.timeline, undefined);
        assert.equal(failed.model.cards.some((c) => c.id === EXTRA), false, 'only the layout fails; the state is the session\'s');
        assert.equal(a.lines.filter((line) => line.startsWith('Team Board: the timeline could not be drawn:')).length, 1, 'one line in the output');
        // Cleared, the next retry draws the timeline again, with no new event in between.
        tap.shape = undefined;
        await panel.receive({ type: 'retry' });
        const back = posted(panel).at(-1)!;
        assert.ok(back.model.timeline !== undefined && back.model.timelineProblem === undefined, 'Draw the timeline again brings the timeline back');
        const count = posted(panel).length;
        await panel.receive({ type: 'retry' });
        assert.equal(posted(panel).length, count, 'a retry with nothing changed sends nothing');
      } finally {
        board.controller.dispose();
      }
    } finally {
      tap.shape = undefined;
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
  for (const type of ['import-plans', 'retry', 'show-details', 'check-team', 'choose-folders'] as const) assert.deepEqual(parseBoardMessage({ type }), { type });
  // The page lives only in the editor tab, so it has nothing to open (G-62-1, T-62-57): the bare open-the-board request is not in the contract.
  assert.equal(parseBoardMessage({ type: 'open-board' }), undefined);
  assert.equal(parseBoardMessage({ type: 'choose-folders', paths: ['/etc'] }), undefined, 'the page cannot hand the host paths');
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
    assert.equal(request?.placeHolder, 'For example: waiting for a teammate\'s answer, or for the API key');
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
    assert.equal(stub.notificationOptions[0]?.detail, 'Use this when the work is finished and added to the project. The whole team will see it as done, and plans that wait for it can become ready. You can reopen it later.');
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
    // The change was made with the viewer's own key (from another window), so the board does not name the viewer as the other person (IN-07).
    assert.equal(refused?.reason, 'Someone already changed this card. The board now shows the latest. Nothing was moved.');
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
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'The team could not be reached, so nothing was changed. Check your internet connection and try again.' });
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
      [new NoDeviceKeyError(), 'This computer is not yet approved to make changes for this team. You can look at the board. Ask your lead to approve this computer.']
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

test('WR-03: an unexpected error from a move, a new item or a model update reaches the output channel redacted, flat and without the credential', async () => {
  await withBoard('owner', async ({ started, ui }) => {
    const secretUrl = 'https://builder:canary-secret-62@git.example.invalid/team.git';
    const thrown = new Error(`push to ${secretUrl} failed\nsecond line\u0007`);
    let failModel = false;
    const session = new Proxy(started.session, {
      get(target, property) {
        if (property === 'currentLog') return () => ({ append: async (): Promise<never> => { throw thrown; } });
        if (property === 'boardStatus' && failModel) return () => { throw thrown; };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
    const lines: string[] = [];
    const { panel, board } = openBoard(session, ui, lines);
    try {
      await panel.receive({ type: 'ready' });
      await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
      await panel.receive({ type: 'new-item', draft: { kind: 'chore', title: 'Tidy up', scope: [] } });
      failModel = true;
      board.controller.sessionChanged();
      const failures = lines.filter((line) => / failed: | could not be updated: /.test(line));
      assert.equal(failures.length >= 3, true, `three failures were written (${failures.length})`);
      assert.equal(lines.some((line) => line.includes('canary-secret-62')), false, 'no credential in the channel');
      assert.equal(lines.some((line) => /[\u0000-\u001F]/.test(line)), false, 'every line is one flat line');
      assert.equal(failures.every((line) => line.includes('https://git.example.invalid/team.git')), true, 'the address is kept without its credentials');
    } finally {
      board.controller.dispose();
    }
  });
});

// Owner decision 2026-11-04 (62-27): a developer moves the cards assigned to them. READY_PLAN is assigned to nobody here, so the developer is told
// the not-assignee sentence (it was "Only the team owner or a lead can move cards.") before any prompt.
test('a developer cannot move a card that is not theirs and is told so before any prompt; a window with no device key is told that instead', async () => {
  await withBoard('dev', async ({ rig, panel }) => {
    const before = remoteEventCount(rig);
    for (const target of ['hold', 'block', 'done'] as const) {
      await panel.receive({ type: 'move', itemId: READY_PLAN, target });
      assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'Only the person assigned, a lead or the owner can move this card. Nothing was moved.' });
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
      assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: READY_PLAN, reason: 'This computer is not yet approved to make changes for this team. You can look at the board. Ask your lead to approve this computer.' });
      assert.equal(stub.inputRequests.length + stub.notifications.length, 0);
    } finally {
      board.controller.dispose();
      keyless.session.dispose();
    }
  });
});

test('a developer blocks the card a lead assigned them after the reason box; on the lead\'s card they are told why before any prompt', async () => {
  await withBoard('dev', async ({ rig, started, panel }) => {
    const owner = await openLog(rig, 'owner');
    const developerId = (await openLog(rig, rig.dev)).memberId as string;
    const leadId = (await openLog(rig, rig.lead)).memberId as string;
    const assigned = await owner.log.append(() => [
      { type: 'item.assigned', body: { id: READY_PLAN, memberId: developerId } }, { type: 'item.assigned', body: { id: DEPENDENT_PLAN, memberId: leadId } }
    ]);
    assert.equal(assigned.ok, true, assigned.ok ? '' : assigned.reason);
    started.timers.fire();
    await until(() => started.session.state().items.get(DEPENDENT_PLAN)?.assignee === leadId, 'the poll to bring the assignments');

    const before = remoteEventCount(rig);
    for (const target of ['block', 'done'] as const) {
      await panel.receive({ type: 'move', itemId: DEPENDENT_PLAN, target });
      assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: DEPENDENT_PLAN, reason: 'Only the person assigned, a lead or the owner can move this card. Nothing was moved.' });
    }
    assert.equal(stub.inputRequests.length + stub.notifications.length, 0, 'no prompt was shown');
    assert.equal(remoteEventCount(rig), before, 'nothing was written');

    stub.inputAnswers.push(WAITING_FOR_KEY);
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'block' });
    assert.equal(stub.inputRequests.length, 1, 'the reason box appeared');
    assert.equal(stub.inputRequests[0]?.title, 'Block 90-02');
    assert.equal(remoteEventCount(rig), before + 1, 'one event was written');
    const remote = await openLog(rig, 'owner');
    assert.equal(remote.log.state().items.get(READY_PLAN)?.blocked?.reason, WAITING_FOR_KEY);
    assert.equal(remote.log.state().items.get(READY_PLAN)?.blocked?.by, developerId);
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
      const record = secondPage(board);
      await record.receive({ type: 'ready' });
      assert.deepEqual(calls, [true], 'told once that the board can be seen');

      panel.setVisible(false);
      assert.deepEqual(calls, [true], 'the second page is still visible');
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
    // A legal move from the developer's page is refused by the host from the log's roster, whatever the page believes. Owner decision 2026-11-04
    // (62-27): READY_PLAN is assigned to nobody, so the refusal is the not-assignee sentence.
    await panel.receive({ type: 'move', itemId: READY_PLAN, target: 'hold' });
    assert.equal((lastOf(panel, 'refused') as { reason?: string } | undefined)?.reason, 'Only the person assigned, a lead or the owner can move this card. Nothing was moved.');
    assert.equal(remoteEventCount(rig), before);
  });
});

test('the page can ask for the import, a retry and the output channel, and a request to open the board does nothing (G-62-1, T-62-57)', async () => {
  await withBoard('owner', async ({ panel, started }) => {
    const ran: Array<{ id: string; args: unknown[] }> = [];
    for (const id of ['nearAi.team.importPlans', 'nearAi.team.openBoard']) stub.commands.set(id, (...args: unknown[]) => { ran.push({ id, args }); });
    let nudged = 0;
    const originalNudge = started.session.nudge.bind(started.session);
    started.session.nudge = (): void => { nudged += 1; originalNudge(); };
    let shown = 0;
    const lines: string[] = [];
    const board = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, { session: () => started.session, output: { appendLine: (line) => { lines.push(line); }, show: () => { shown += 1; } }, timers: new LiveTimers() });
    board.openPanel();
    const second = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    try {
      const panelsBefore = stub.webviewPanels.length;
      const postedBefore = second.posted.length;
      await second.receive({ type: 'open-board' });
      assert.deepEqual(ran, [], 'asking the host to open the board runs no command');
      assert.equal(stub.webviewPanels.length, panelsBefore, 'and opens no panel');
      assert.equal(second.posted.length, postedBefore, 'and gets no answer');
      assert.equal(second.revealCalls + panel.revealCalls, 0, 'and reveals nothing');
      await second.receive({ type: 'import-plans' });
      await second.receive({ type: 'retry' });
      await second.receive({ type: 'show-details' });
      assert.deepEqual(ran, [{ id: 'nearAi.team.importPlans', args: [{ milestone: 'current' }] }]);
      assert.equal(nudged, 1);
      assert.equal(shown, 1);
      assert.deepEqual(lines, [], 'nothing failed');
      assert.ok(panel.posted.length > 0);
    } finally {
      board.controller.dispose();
    }
  });
});

test('T-62-49: the page gets one item write, one import and one retry at a time, a cool-down between imports and retries, and a small write bucket', async () => {
  await withBoard('owner', async ({ rig, started }) => {
    const ran: string[] = [];
    stub.commands.set('nearAi.team.importPlans', () => { ran.push('import'); });
    let nudged = 0;
    const originalNudge = started.session.nudge.bind(started.session);
    started.session.nudge = (): void => { nudged += 1; originalNudge(); };
    const clock = { value: 1_000_000 };
    const board = registerTeamBoard(createFakeContext(EXTENSION_ROOT, {}) as never, {
      session: () => started.session, output: { appendLine: () => undefined, show: () => undefined }, timers: new LiveTimers(), nowMs: () => clock.value,
      requestLimits: { coolDownMs: 2_000, writeBurst: 2, writeRefillMs: 1_000 }
    });
    board.openPanel();
    const page = stub.webviewPanels[stub.webviewPanels.length - 1] as RecordedWebviewPanel;
    const notices = (): string[] => page.posted.filter((message) => (message as { type?: string }).type === 'notice').map((message) => String((message as { text?: unknown }).text));
    const busy = 'The board is still saving your last change. Try again in a moment. Nothing was saved.';
    try {
      await page.receive({ type: 'ready' });
      const draft = (title: string): unknown => ({ type: 'new-item', draft: { kind: 'chore', title, scope: [] } });

      // Two at once: the second is refused while the first is saving, and only one item is written.
      const before = remoteEventCount(rig);
      const first = page.receive(draft('First'));
      await page.receive(draft('Second'));
      assert.deepEqual(lastOf(page, 'refused'), { type: 'refused', itemId: '', reason: busy });
      await first;
      assert.equal(remoteEventCount(rig), before + 1, 'one item was written');

      // The bucket holds two writes: the first is spent, one more goes through, the next waits for the refill.
      await page.receive(draft('Third'));
      assert.equal(remoteEventCount(rig), before + 2);
      await page.receive(draft('Fourth'));
      assert.deepEqual(lastOf(page, 'refused'), { type: 'refused', itemId: '', reason: busy });
      assert.equal(remoteEventCount(rig), before + 2, 'nothing more was written');
      clock.value += 1_000;
      await page.receive(draft('Fifth'));
      assert.equal(remoteEventCount(rig), before + 3, 'one write came back after the refill');

      // Import and retry: one start per cool-down, the extra one gets a plain notice.
      await page.receive({ type: 'import-plans' });
      await page.receive({ type: 'import-plans' });
      await page.receive({ type: 'retry' });
      await page.receive({ type: 'retry' });
      assert.deepEqual(ran, ['import']);
      assert.equal(nudged, 1);
      assert.deepEqual(notices(), ['An import of the plans is already running or just ran. Try again in a moment.', 'The board is already checking for changes. Try again in a moment.']);
      clock.value += 2_000;
      await page.receive({ type: 'import-plans' });
      await page.receive({ type: 'retry' });
      assert.deepEqual(ran, ['import', 'import'], 'after the cool-down the import runs again');
      assert.equal(nudged, 2);
      assert.equal(notices().every((text) => !/\u2014|\u2013/.test(text)), true);
    } finally {
      board.controller.dispose();
    }
  });
});

// ---- the commands in a team project ----------------------------------------------------------------------------------------------------------

const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const importModule = require('../team/importPlans') as typeof import('../team/importPlans');
const setContexts = (): Array<{ command: string; args: unknown[] }> => stub.externalCommands.filter((entry) => entry.command === 'setContext');

test('team project: nothing opens when the session starts, Open Team Board opens one panel and reveals it again, and the context key follows the window', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    stub.setWorkspaceFolders([rootOf(rig, 'a')]);
    const context = createFakeContext(rig.owner.globalStorageDir, rig.owner.secrets);
    const handle = commandsModule.registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    try {
      assert.equal(await handle.ready, 'team');
      assert.deepEqual(setContexts(), [{ command: 'setContext', args: ['nearAi.teamMode', true] }], 'the context key is set once the session runs');
      // Owner decision 2026-11-03 (G-62-1): no sidebar board view, and nothing opens by itself when the session starts.
      assert.equal(stub.viewProviders.length, 0, 'no view provider is registered');
      assert.equal(stub.webviewPanels.length, 0, 'no panel until someone asks');

      await stub.commands.get(commandsModule.OPEN_BOARD_COMMAND)?.();
      assert.equal(stub.webviewPanels.length, 1);
      assert.equal(stub.webviewPanels[0]?.viewType, 'nearAiTeamBoard');
      await stub.commands.get(commandsModule.OPEN_BOARD_COMMAND)?.();
      assert.equal(stub.webviewPanels.length, 1, 'a second run reveals the open panel');
      assert.equal(stub.webviewPanels[0]?.revealCalls, 1);
      assert.equal(stub.viewProviders.length, 0, 'still no view provider');
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

test('UI review warning 2: Check the team on the paused banner runs the Check Team Record command, once per cool-down', async () => {
  await withBoard('owner', async ({ panel }) => {
    const ran: string[] = [];
    stub.commands.set('nearAi.team.verifyLog', () => { ran.push('check'); });
    await panel.receive({ type: 'check-team' });
    await panel.receive({ type: 'check-team' });
    assert.deepEqual(ran, ['check']);
    assert.deepEqual(lastOf(panel, 'notice'), { type: 'notice', text: 'The team is already being checked. Try again in a moment.' });
  });
});

test('J-01: Choose folders... opens the folder picker in the project and answers with project-relative paths only', async () => {
  await withBoard('owner', async ({ rig, panel }) => {
    const root = rootOf(rig, 'a');
    stub.setWorkspaceFolders([root]);
    stub.openDialogRequests.length = 0;
    stub.openDialogAnswers.length = 0;
    stub.openDialogAnswers.push([path.join(root, 'src', 'settings'), path.join(root, 'docs'), root, path.join(path.dirname(root), 'elsewhere'), path.join(root, 'docs')]);
    await panel.receive({ type: 'choose-folders' });
    const asked = stub.openDialogRequests[0] as { canSelectFolders?: boolean; canSelectMany?: boolean; defaultUri?: { fsPath: string }; title?: string; openLabel?: string };
    assert.deepEqual([asked.canSelectFolders, asked.canSelectMany, asked.defaultUri?.fsPath, asked.title, asked.openLabel], [true, true, root, 'Choose the parts of the project this item covers', 'Add to the item']);
    assert.deepEqual(lastOf(panel, 'folders-chosen'), { type: 'folders-chosen', paths: ['src/settings', 'docs'] }, 'the project itself, a folder outside it and a repeat are left out');
    const before = panel.posted.length;
    await panel.receive({ type: 'choose-folders' });
    assert.equal(panel.posted.length, before, 'a dismissed picker sends nothing');
  });
});
