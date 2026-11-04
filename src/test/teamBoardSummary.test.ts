// The sidebar's one-line board summary (G-62-1, plan 62-18): with the board in its own editor tab only, the Team section of the NEAR AI sidebar shows
// how many cards are ready, how many are blocked and how many are the person's own, beside Open board. The numbers come from the board model itself,
// so they can never disagree with the board; a running session supplies them through the Team Mode handle, and the section refreshes on the
// session's own state changes (no timer of its own). The vscode stub is installed for the whole file; lazy requires keep every vscode import behind it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { importPlans } from '../team/importPlans';
import { CHORE_ID, boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import { openLog, rootOf, storageOf } from './helpers/teamFlowRig';
import type { Rig } from './helpers/teamFlowRig';
import { until, withLiveTeam } from './helpers/teamLiveRig';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
test.after(() => { uninstall(); });
const boardModule = require('../domain/team/board') as typeof import('../domain/team/board');
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const { createTeamSectionHost } = require('../services/team/teamSectionHost') as typeof import('../services/team/teamSectionHost');
const text = require('../domain/team/teamSectionText') as typeof import('../domain/team/teamSectionText');
type TeamState = import('../domain/team/types').TeamState;
type TeamModeHandle = import('../services/team/teamCommands').TeamModeHandle;
type Model = import('../domain/team/teamSection').TeamSectionModel;
interface Summary { ready: number; blocked: number; mine: number }

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
// The fixture's plan:90-01 has a summary, so it is Done; plan:90-02 is the one that is Ready.
const READY_PLAN = 'plan:90-02';

// The function under test, read loosely so a missing export fails an assertion rather than the build.
function summaryOf(state: TeamState, viewerId: string | undefined): Summary {
  const fn = (boardModule as unknown as { boardSummary?: (state: TeamState, viewerId: string | undefined) => Summary }).boardSummary;
  assert.equal(typeof fn, 'function', 'board.ts exports boardSummary');
  return (fn as (state: TeamState, viewerId: string | undefined) => Summary)(state, viewerId);
}
function handleSummary(handle: TeamModeHandle): Summary | undefined {
  const fn = (handle as unknown as { boardSummary?: () => Summary | undefined }).boardSummary;
  assert.equal(typeof fn, 'function', 'the Team Mode handle has boardSummary()');
  return (fn as () => Summary | undefined).call(handle);
}

// What the board itself shows for this viewer: Ready and Blocked as the board counts them for the current milestone, and the cards the Mine filter
// keeps (card.mine) in that milestone that are not Done or Cancelled.
function boardNumbers(state: TeamState, viewerId: string | undefined): Summary {
  const model = boardModule.buildBoardModel(state, { nowMs: 0, status: { kind: 'live', text: 'Live' }, canWrite: true, ...(viewerId === undefined ? {} : { viewerId }) });
  const selected = model.selectedMilestone;
  const shown = model.cards.filter((card) => selected === 'all' || card.milestoneId === selected || card.milestoneId === undefined);
  const mine = shown.filter((card) => card.mine && card.column !== 'done' && card.column !== 'cancelled').length;
  return { ready: model.counts.ready, blocked: model.counts.blocked, mine };
}

const states = (record: RecordedWebview): Array<Model | null> =>
  record.posted.filter((message): message is { type: 'team-state'; model: Model | null } => (message as { type?: string }).type === 'team-state').map((message) => message.model);
const lastState = (record: RecordedWebview): Model | null | undefined => states(record).at(-1);

function resetStub(): void {
  for (const list of [stub.outputChannels, stub.statusBarItems, stub.notifications, stub.notificationActions, stub.notificationOptions, stub.inputAnswers, stub.inputRequests,
    stub.messageAnswers, stub.quickPickAnswers, stub.quickPickRequests, stub.externalCommands, stub.progress, stub.webviewPanels, stub.viewProviders]) (list as unknown[]).length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
  stub.setWorkspaceFolders([]);
}

async function importFixture(rig: Rig): Promise<void> {
  const owner = await openLog(rig, 'owner');
  const result = await importPlans({
    log: owner.log, source: { projectRoot: rootOf(rig, 'a'), remote: 'origin', branch: 'main' }, storageDir: storageOf(rig, 'owner'), mode: 'command'
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
}

interface LeadWindow { handle: TeamModeHandle; context: ReturnType<typeof createFakeContext>; record: RecordedWebview; host: ReturnType<typeof createTeamSectionHost>; before: Summary | undefined }

// The lead's VS Code window on clone c, with Team Mode registered as the product does and the sidebar Team section wired as extension.ts wires it.
async function openLeadWindow(rig: Rig): Promise<LeadWindow> {
  resetStub();
  stub.setWorkspaceFolders([rootOf(rig, 'c')]);
  const context = createFakeContext(rig.lead.globalStorageDir, rig.lead.secrets);
  const handle = commandsModule.registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
  let host: ReturnType<typeof createTeamSectionHost> | undefined;
  try {
    // Read before the session has started: there is nothing to summarise yet.
    const before = handleSummary(handle);
    assert.equal(await handle.ready, 'team');
    host = createTeamSectionHost({
      team: handle, firstFolder: () => rootOf(rig, 'c'), testSeams: false, checkShared: async () => 'yes', executeCommand: async () => undefined,
      boardSummary: () => handleSummary(handle)
    });
    const made = stub.createWebviewView();
    const view = made.view as { webview: Parameters<typeof host.attach>[0] };
    host.attach(view.webview);
    await host.refresh();
    return { handle, context, record: made.record, host, before };
  } catch (error) {
    // A failed open still closes the window, so no session keeps polling after the test.
    host?.dispose();
    await handle.ready.catch(() => undefined);
    for (const subscription of context.subscriptions) subscription.dispose();
    throw error;
  }
}

async function closeLeadWindow(window: LeadWindow | undefined): Promise<void> {
  if (window === undefined) return;
  window.host.dispose();
  await window.handle.session()?.sync().catch(() => undefined);
  for (const subscription of window.context.subscriptions) subscription.dispose();
}

// ---- Task 1: the tracer ------------------------------------------------------------------------------------------------------------------

test('boardSummary gives the board\'s own numbers: Ready and Blocked as the board counts them, and the viewer\'s unfinished cards', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  world.accept(world.owner, 'item.blocked', { id: 'plan:90-02', reason: 'waiting for a teammate' });
  for (const viewer of [world.dev, world.lead, world.owner]) {
    const memberId = viewer.memberId;
    assert.deepEqual(summaryOf(world.state, memberId), boardNumbers(world.state, memberId));
  }
  assert.deepEqual(summaryOf(world.state, world.dev.memberId), { ready: 1, blocked: 1, mine: 1 }, 'plan:90-01 is ready, plan:90-02 is blocked, the chore is the developer\'s');
  assert.deepEqual(summaryOf(world.state, undefined), { ready: 1, blocked: 1, mine: 0 }, 'no viewer has no cards of their own');
});

test('tracer: a lead\'s running session gives the sidebar Team section a summary line with ready, blocked and mine counts', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    let window: LeadWindow | undefined;
    try {
      window = await openLeadWindow(rig);
      assert.equal(window.before, undefined, 'no summary before the session runs');
      const session = window.handle.session();
      assert.ok(session !== undefined, 'the lead\'s session runs');
      assert.equal(boardModule.buildBoardModel(session.state(), { nowMs: 0, status: { kind: 'live', text: 'Live' }, canWrite: true }).cards.find((card) => card.id === READY_PLAN)?.column, 'ready');
      const expected = boardNumbers(session.state(), session.memberId());
      assert.ok(expected.ready >= 1, 'the fixture has a ready plan');
      assert.deepEqual(handleSummary(window.handle), expected, 'the handle gives the board\'s numbers');
      assert.deepEqual(lastState(window.record)?.board, { ...expected, text: text.boardSummaryText(expected.ready, expected.blocked, expected.mine) }, 'the Team section shows the line');
      assert.ok(lastState(window.record)?.actions.some((action) => action.id === 'board'), 'beside Open board');
    } finally {
      await closeLeadWindow(window);
    }
  });
});

test('extension.ts gives the Team section host the Team Mode handle\'s board summary', () => {
  const source = readFileSync(path.join(EXTENSION_ROOT, 'src', 'extension.ts'), 'utf8');
  const call = source.slice(source.indexOf('createTeamSectionHost({'));
  const args = call.slice(0, call.indexOf('});'));
  assert.match(args, /boardSummary:\s*\(\)\s*=>\s*team\.boardSummary\(\)/, 'the host reads the summary from the handle on every refresh');
});
