// Board-created items (Phase 62 plan 13, D-14): a developer adds a chore through the page protocol and the real host, the item reaches the remote as one
// signed item.created that already carries the estimate, and every teammate sees it with its creator. Real clones and real git throughout.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { openLog, rootOf } from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { LiveTimers, until, withLiveTeam } from './helpers/teamLiveRig';
import { gitIn } from './helpers/teamHarness';
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
const { registerTeamBoard } = boardModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const ITEM_ID = /^item:[0-9A-HJKMNP-TV-Z]{26}$/;

interface Started { session: Session; lines: string[]; timers: LiveTimers }

async function startSession(rig: Rig, who: 'owner' | Participant): Promise<Started> {
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
  assert.ok(rig.teamFile !== undefined);
  const session = await TeamSession.start({
    projectRoot: root, globalStorageDir: person === undefined ? rig.owner.globalStorageDir : person.globalStorageDir, teamFile: rig.teamFile,
    secrets: person === undefined ? rig.owner.secrets : person.secrets,
    output: { appendLine: (line) => { lines.push(line); }, show: () => undefined },
    statusBar: createTeamStatusBar(), audit: projectAuditSink(root),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => true, timers, nearBaseUrl: rig.fake.baseUrl, autoImport: false
  });
  await until(() => timers.live.length === 1, 'the first poll to be armed');
  return { session, lines, timers };
}

function resetStub(): void {
  stub.webviewPanels.length = 0;
  stub.viewProviders.length = 0;
  stub.notifications.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
}

interface BoardCtx { rig: Rig; started: Started; panel: RecordedWebviewPanel; ui: LiveTimers; board: ReturnType<typeof registerTeamBoard> }

// A freshly opened board of one computer, after the page said ready. `before` runs on the owner's log before the session starts (a role change, say).
async function withBoard(who: 'owner' | 'dev' | 'lead', run: (ctx: BoardCtx) => Promise<void>, before?: (rig: Rig) => Promise<void>): Promise<void> {
  resetStub();
  await withLiveTeam(async (rig) => {
    if (before !== undefined) await before(rig);
    const started = await startSession(rig, who === 'owner' ? 'owner' : who === 'dev' ? rig.dev : rig.lead);
    const ui = new LiveTimers();
    const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
    const board = registerTeamBoard(context as never, { session: () => started.session, output: { appendLine: (line) => { started.lines.push(line); }, show: () => undefined }, timers: ui });
    board.openPanel();
    const panel = stub.webviewPanels[stub.webviewPanels.length - 1];
    assert.ok(panel !== undefined, 'a panel was created');
    try {
      await panel.receive({ type: 'ready' });
      await run({ rig, started, panel, ui, board });
    } finally {
      board.controller.dispose();
      started.session.dispose();
    }
  }, { planning: false });
}

const lastOf = (record: RecordedWebview, type: string): Record<string, unknown> | undefined =>
  [...record.posted].reverse().find((message): message is Record<string, unknown> => (message as { type?: string }).type === type);

const eventFiles = (rig: Rig): string[] => gitIn(rig.fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((line) => line.startsWith('events/'));

interface RemoteEvent { type: string; author: string; body: Record<string, unknown> }
const eventAt = (rig: Rig, file: string): RemoteEvent => JSON.parse(gitIn(rig.fixture.remote, ['show', `${DEFAULT_COORDINATION_REF}:${file}`])) as RemoteEvent;
const newEvents = (rig: Rig, before: string[]): RemoteEvent[] => eventFiles(rig).filter((file) => !before.includes(file)).sort().map((file) => eventAt(rig, file));

const DRAFT = { kind: 'chore', title: 'Tidy settings page', description: 'Group the team settings.', scope: ['src/services/settings/**'], estimate: 48000 };

test('tracer: a developer adds a chore through the page and the host, the remote gains one item.created with the estimate, and the owner sees the developer as its creator', async () => {
  await withBoard('dev', async ({ rig, started, panel, ui }) => {
    const before = eventFiles(rig);
    await panel.receive({ type: 'new-item', draft: DRAFT });

    const written = newEvents(rig, before);
    assert.equal(written.length, 1, 'one event, one commit');
    const event = written[0] as RemoteEvent;
    assert.equal(event.type, 'item.created');
    assert.equal(event.author, rig.dev.memberId);
    const id = event.body['id'];
    assert.equal(typeof id === 'string' && ITEM_ID.test(id), true, 'a board item id');
    assert.deepEqual(event.body, {
      id, kind: 'chore', title: 'Tidy settings page', description: 'Group the team settings.', scope: ['src/services/settings/**'],
      requirements: [], mustHaves: [], estimate: { tokens: 48000 }
    });

    assert.deepEqual(lastOf(panel, 'saved'), { type: 'saved', itemId: id });
    assert.equal(lastOf(panel, 'refused'), undefined);
    // The state that follows shows the card, ready (it has files and an estimate), and mine.
    const savedAt = panel.posted.findIndex((message) => (message as { type?: string }).type === 'saved');
    const after = panel.posted.slice(savedAt).find((message) => (message as { type?: string }).type === 'state') as { model: { cards: Array<{ id: string; column: string; mine: boolean }> } } | undefined;
    const card = after?.model.cards.find((candidate) => candidate.id === id);
    assert.equal(card?.column, 'ready');
    assert.equal(card?.mine, true);
    assert.equal(started.session.state().items.get(id as string)?.createdBy, rig.dev.memberId);
    assert.equal(ui.live.length <= 1, true);

    const owner = await openLog(rig, 'owner');
    const item = owner.log.state().items.get(id as string);
    assert.equal(item?.origin, 'board');
    assert.equal(item?.createdBy, rig.dev.memberId);
    assert.equal(item?.title, 'Tidy settings page');
  });
});

test('an item with only a title is written without a description or an estimate and waits in the backlog', async () => {
  await withBoard('dev', async ({ rig, panel }) => {
    const before = eventFiles(rig);
    await panel.receive({ type: 'new-item', draft: { kind: 'bug', title: '  Crash on save  ', description: '', scope: [' ', 'src/a/**  '] } });
    const written = newEvents(rig, before);
    assert.equal(written.length, 1);
    const body = (written[0] as RemoteEvent).body;
    assert.deepEqual(body, { id: body['id'], kind: 'bug', title: 'Crash on save', scope: ['src/a/**'], requirements: [], mustHaves: [] });
  });
});
