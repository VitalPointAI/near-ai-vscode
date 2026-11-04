// Assigning a card from the Team Board (Phase 62 plan 20, G-62-5, owner decision 2026-11-03): the host side of Assign to..., Unassign, Assign to me and
// Unassign me, on real team sessions over real clones. The page sends only { type, itemId }; the host decides from the log who is meant, shows the native
// person list to the owner and leads (through teamPrompts, so the real-window test can answer it), and plans the write three times: on what the window
// knew, on what it knows after the list, and on the freshest state inside the append. Lazy requires keep every vscode import behind the stub.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { importPlans } from '../team/importPlans';
import { openLog, remoteEventCount, rootOf, storageOf } from './helpers/teamFlowRig';
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
const { boardTap, parseBoardMessage, registerTeamBoard } = boardModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;
type SessionDeps = Parameters<typeof TeamSession.start>[0];
type RequestLimits = import('../services/team/boardView').BoardRequestLimits;

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
// The fixture's plan:90-02 is Ready and nobody is on it.
const PLAN = 'plan:90-02';
const DANA = 'Dana Developer';
const LENA = 'Lena Lead';
const OWNER = 'Owner Test';
const STALE_TAIL = 'already changed this card. The board now shows the latest. Nothing was moved.';
const OBSERVER_SENTENCE = 'Only team members who work on cards can take one. A lead can change your role. Nothing was changed.';
const BUSY = 'The board is still saving your last change. Try again in a moment. Nothing was saved.';
const OFFLINE = 'The team could not be reached, so nothing was changed. Check your internet connection and try again.';

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
  } satisfies SessionDeps);
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

interface CardView { id: string; column: string; assignee?: { id: string; name: string; initials: string }; assignActions: string[]; lane: { member: string } }
interface StateMessage { type: 'state'; model: { cards: CardView[] } }
const states = (record: RecordedWebview): StateMessage[] => record.posted.filter((message): message is StateMessage => (message as { type?: string }).type === 'state');
const latestCard = (record: RecordedWebview, id: string): CardView | undefined => states(record).at(-1)?.model.cards.find((card) => card.id === id);
const lastOf = (record: RecordedWebview, type: string): Record<string, unknown> | undefined =>
  [...record.posted].reverse().find((message): message is Record<string, unknown> => (message as { type?: string }).type === type);

function resetStub(): void {
  stub.webviewPanels.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.notificationOptions.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
  boardTap.toView = undefined;
  boardTap.fromView = undefined;
}

function openBoard(started: Started, requestLimits?: RequestLimits): { panel: RecordedWebviewPanel; board: ReturnType<typeof registerTeamBoard> } {
  const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
  const board = registerTeamBoard(context as never, {
    session: () => started.session, output: { appendLine: (line) => { started.lines.push(line); }, show: () => undefined }, timers: new LiveTimers(),
    ...(requestLimits === undefined ? {} : { requestLimits })
  });
  board.openPanel();
  const panel = stub.webviewPanels[stub.webviewPanels.length - 1];
  assert.ok(panel !== undefined, 'a panel was created');
  return { panel, board };
}

interface Ctx { rig: Rig; started: Started; panel: RecordedWebviewPanel }

// One computer's board on the fixture roadmap. `before` runs on the remote first (for example a role change), so the session starts on it.
async function withBoard(who: 'owner' | 'dev' | 'lead', run: (ctx: Ctx) => Promise<void>, options: { before?: (rig: Rig) => Promise<void>; requestLimits?: RequestLimits } = {}): Promise<void> {
  resetStub();
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    if (options.before !== undefined) await options.before(rig);
    const started = await startSession(rig, who === 'owner' ? 'owner' : who === 'dev' ? rig.dev : rig.lead);
    const { panel, board } = openBoard(started, options.requestLimits);
    try {
      await panel.receive({ type: 'ready' });
      await run({ rig, started, panel });
    } finally {
      board.controller.dispose();
      started.session.dispose();
    }
  });
}

async function remoteAssignee(rig: Rig, itemId: string): Promise<string | undefined> {
  const remote = await openLog(rig, 'owner');
  return (remote.log.state().items.get(itemId) as { assignee?: string } | undefined)?.assignee;
}

// The newest event on the remote, read straight from git: its type and body.
function newestRemoteEvent(rig: Rig): { type: string; body: Record<string, unknown> } {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: rig.fixture.remote, encoding: 'utf8' });
  const names = git(['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((name) => name.startsWith('events/')).sort();
  const newest = names.at(-1);
  assert.ok(newest !== undefined, 'the remote has events');
  return JSON.parse(git(['show', `${DEFAULT_COORDINATION_REF}:${newest}`])) as { type: string; body: Record<string, unknown> };
}

// ---- the page protocol (T-62-64) ---------------------------------------------------------------------------------------------------------------

test('parseBoardMessage accepts exactly { type: assign or unassign, itemId } and refuses a member id, extra keys and odd ids', () => {
  assert.deepEqual(parseBoardMessage({ type: 'assign', itemId: PLAN }), { type: 'assign', itemId: PLAN });
  assert.deepEqual(parseBoardMessage({ type: 'unassign', itemId: PLAN }), { type: 'unassign', itemId: PLAN });
  const hostile: unknown[] = [
    { type: 'assign', itemId: PLAN, memberId: 'member:someone' }, { type: 'unassign', itemId: PLAN, memberId: 'member:someone' },
    { type: 'assign', itemId: PLAN, to: 'Dana' }, { type: 'assign', itemId: PLAN, role: 'owner' }, { type: 'assign' }, { type: 'unassign' },
    { type: 'assign', itemId: 'plan:../x' }, { type: 'assign', itemId: 'x'.repeat(500) }, { type: 'assign', itemId: 'item:not-a-ulid' },
    { type: 'assign', itemId: 7 }, { type: 'unassign', itemId: null }, { type: 'assign', itemId: [PLAN] },
    JSON.parse('{"type":"assign","itemId":"plan:90-02","__proto__":{"memberId":"member:x"}}')
  ];
  for (const value of hostile) assert.equal(parseBoardMessage(value), undefined, JSON.stringify(value));
});

test('an assign message that names a person is ignored: no list is shown and nothing reaches the remote', async () => {
  await withBoard('owner', async ({ rig, panel }) => {
    const before = remoteEventCount(rig);
    const dana = rig.dev.memberId as string;
    await panel.receive({ type: 'assign', itemId: PLAN, memberId: dana });
    await panel.receive({ type: 'unassign', itemId: PLAN, memberId: dana });
    await panel.receive({ type: 'assign', itemId: PLAN, extra: true });
    assert.equal(stub.quickPickRequests.length, 0, 'no person list');
    assert.equal(lastOf(panel, 'refused'), undefined, 'nothing is answered either');
    assert.equal(remoteEventCount(rig), before, 'no event was written');
  });
});

// ---- Task 1: the tracer --------------------------------------------------------------------------------------------------------------------------

test('tracer: a lead chooses Assign to..., picks Dana from the host list, and the card comes back showing Dana in her lane', async () => {
  await withBoard('lead', async ({ rig, panel }) => {
    const first = latestCard(panel, PLAN);
    assert.ok(first !== undefined, 'the card is on the board');
    assert.equal(first.assignee, undefined);
    assert.deepEqual(first.assignActions, ['assign'], 'a lead is offered Assign to... on a free card');
    const before = remoteEventCount(rig);

    stub.quickPickAnswers.push(DANA);
    await panel.receive({ type: 'assign', itemId: PLAN });

    assert.equal(stub.quickPickRequests.length, 1, 'one native person list');
    const list = stub.quickPickRequests[0]!;
    assert.deepEqual(list.labels, [DANA, LENA, OWNER], 'the eligible people by name, sorted');
    assert.deepEqual(list.descriptions, ['Developer', 'Lead', 'Owner'], 'with their role words');
    assert.match(list.title ?? '', /90-02/, 'titled with the card');
    assert.equal(remoteEventCount(rig), before + 1, 'one event was written');
    assert.deepEqual(newestRemoteEvent(rig), { ...newestRemoteEvent(rig), type: 'item.assigned', body: { id: PLAN, memberId: rig.dev.memberId } });
    assert.equal(await remoteAssignee(rig, PLAN), rig.dev.memberId);

    const after = latestCard(panel, PLAN);
    assert.deepEqual(after?.assignee, { id: rig.dev.memberId, name: DANA, initials: 'DD' });
    assert.equal(after?.lane.member, rig.dev.memberId, 'the card sits in her lane');
    assert.deepEqual(after?.assignActions, ['assign', 'unassign']);
  });
});

test('the person list marks the one who has the card, and choosing them again or closing the list changes nothing', async () => {
  await withBoard('lead', async ({ rig, panel }) => {
    stub.quickPickAnswers.push(DANA);
    await panel.receive({ type: 'assign', itemId: PLAN });
    const before = remoteEventCount(rig);

    stub.quickPickAnswers.push(DANA);
    await panel.receive({ type: 'assign', itemId: PLAN });
    assert.deepEqual(stub.quickPickRequests[1]?.descriptions, ['Developer, has this card now', 'Lead', 'Owner'], 'the current one is marked');
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: PLAN, reason: '' }, 'the same person is no change, said silently');

    stub.quickPickAnswers.push(undefined);
    await panel.receive({ type: 'assign', itemId: PLAN });
    assert.deepEqual(lastOf(panel, 'refused'), { type: 'refused', itemId: PLAN, reason: '' }, 'a closed list clears the pending line silently');
    assert.equal(remoteEventCount(rig), before, 'nothing was written');
    assert.equal(await remoteAssignee(rig, PLAN), rig.dev.memberId);
  });
});
