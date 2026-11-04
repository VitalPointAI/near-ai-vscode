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
import { openLog, remove, rootOf, storageOf } from './helpers/teamFlowRig';
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

const summaryOf = (state: TeamState, viewerId: string | undefined): Summary => boardModule.boardSummary(state, viewerId);
const handleSummary = (handle: TeamModeHandle): Summary | undefined => handle.boardSummary();

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

// ---- Task 2: the rules, the live refresh and the removed member ----------------------------------------------------------------------------

const SECOND_CHORE = `item:${'0'.repeat(22)}7F3M`;
const THIRD_CHORE = `item:${'0'.repeat(22)}7F3N`;
const LEAD_CHORE = `item:${'0'.repeat(22)}7F3P`;
const chore = (id: string, title: string) => ({ id, kind: 'chore' as const, title, scope: [], requirements: [], mustHaves: [] });

test('Done and Cancelled cards never count: a finished or cancelled card of the developer\'s own is not theirs to do, and a done plan is not ready', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  world.accept(world.dev, 'item.created', chore(SECOND_CHORE, 'Second chore'));
  world.accept(world.dev, 'item.created', chore(THIRD_CHORE, 'Third chore'));
  assert.deepEqual(summaryOf(world.state, world.dev.memberId), { ready: 1, blocked: 0, mine: 3 });
  world.accept(world.owner, 'item.cancelled', { id: SECOND_CHORE, reason: 'not needed' });
  world.accept(world.owner, 'item.updated', { id: THIRD_CHORE, changes: { state: 'done' } });
  assert.deepEqual(summaryOf(world.state, world.dev.memberId), { ready: 1, blocked: 0, mine: 1 }, 'only the open chore is still theirs');
  // plan:90-01 is done; plan:90-02, which waited for it, is ready now. The done plan counts nowhere.
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  const model = boardModule.buildBoardModel(world.state, { nowMs: 0, status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: world.dev.memberId });
  assert.deepEqual(model.cards.filter((card) => card.column === 'ready').map((card) => card.id), ['plan:90-02']);
  assert.deepEqual(summaryOf(world.state, world.dev.memberId), { ready: 1, blocked: 0, mine: 1 });
  assert.deepEqual(summaryOf(world.state, world.dev.memberId), boardNumbers(world.state, world.dev.memberId));
});

test('a blocked card in Backlog counts as blocked and not as ready', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  assert.deepEqual(summaryOf(world.state, world.lead.memberId), { ready: 1, blocked: 0, mine: 0 });
  world.accept(world.owner, 'item.blocked', { id: 'plan:90-01', reason: 'waiting for the API key' });
  const card = boardModule.buildBoardModel(world.state, { nowMs: 0, status: { kind: 'live', text: 'Live' }, canWrite: true }).cards.find((entry) => entry.id === 'plan:90-01');
  assert.equal(card?.column, 'backlog', 'a blocked plan shows in Backlog');
  assert.deepEqual(summaryOf(world.state, world.lead.memberId), { ready: 0, blocked: 1, mine: 0 });
  // A blocked board item of the developer's own is theirs and blocked at once.
  world.accept(world.owner, 'item.blocked', { id: CHORE_ID, reason: 'waiting for the design' });
  assert.deepEqual(summaryOf(world.state, world.dev.memberId), { ready: 0, blocked: 2, mine: 1 });
});

test('cards of a milestone other than the current one count in neither ready nor blocked', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  const before = summaryOf(world.state, world.lead.memberId);
  world.accept(world.owner, 'item.imported', importedBody({ id: 'milestone:v1.0.0', kind: 'milestone', title: 'Version 1.0.0' }));
  world.accept(world.owner, 'item.imported', importedBody({ id: 'phase:100', kind: 'phase', title: 'Later work', parentId: 'milestone:v1.0.0' }));
  for (const plan of ['01', '02']) {
    world.accept(world.owner, 'item.imported', importedBody({
      id: `plan:100-${plan}`, kind: 'plan', title: `Later ${plan}`, parentId: 'phase:100', scope: ['src/later/**'], estimate: { tokens: 1000 }, gsd: { phase: '100', plan, wave: 1 }
    }));
  }
  world.accept(world.owner, 'item.blocked', { id: 'plan:100-02', reason: 'waiting for the release' });
  const model = boardModule.buildBoardModel(world.state, { nowMs: 0, status: { kind: 'live', text: 'Live' }, canWrite: true });
  assert.equal(model.selectedMilestone, 'milestone:v0.9.0', 'the current milestone is still the active one');
  assert.equal(model.cards.find((card) => card.id === 'plan:100-01')?.column, 'ready', 'the later plan is ready on its own milestone');
  assert.deepEqual(summaryOf(world.state, world.lead.memberId), before);
});

test('a developer\'s mine counts the board item they added and nothing a lead added; an observer\'s mine is 0', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  world.accept(world.lead, 'item.created', chore(LEAD_CHORE, 'Lead chore'));
  assert.equal(summaryOf(world.state, world.dev.memberId).mine, 1, 'the developer\'s own chore');
  assert.equal(summaryOf(world.state, world.lead.memberId).mine, 1, 'the lead\'s own chore');
  assert.equal(summaryOf(world.state, world.owner.memberId).mine, 0, 'imported plans are nobody\'s own');
  assert.equal(summaryOf(world.state, world.observer.memberId).mine, 0);
  assert.equal(summaryOf(world.state, world.reviewer.memberId).mine, 0);
});

// Records where every timer was made, so a test can tell whether the Team section or the summary made one.
function timerOrigins(): { stacks: string[]; restore(): void } {
  const g = globalThis as unknown as Record<'setTimeout' | 'setInterval', (...args: unknown[]) => unknown>;
  const real = { setTimeout: g.setTimeout, setInterval: g.setInterval };
  const stacks: string[] = [];
  g.setTimeout = (...args: unknown[]): unknown => { stacks.push(new Error('timer').stack ?? ''); return real.setTimeout(...args); };
  g.setInterval = (...args: unknown[]): unknown => { stacks.push(new Error('timer').stack ?? ''); return real.setInterval(...args); };
  return { stacks, restore: () => { Object.assign(g, real); } };
}
const OWN_CODE = [path.join('services', 'team', 'teamSectionHost.js'), path.join('domain', 'team', 'board.js'), path.join('domain', 'team', 'teamSection.js')];

test('a teammate blocks a ready plan: after the lead\'s session syncs, the line shows one fewer ready and one more blocked, with no timer of its own', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    let window: LeadWindow | undefined;
    let spy: ReturnType<typeof timerOrigins> | undefined;
    try {
      window = await openLeadWindow(rig);
      const before = lastState(window.record)?.board;
      assert.ok(before !== undefined && before.ready >= 1, 'the line is shown with a ready plan');
      const session = window.handle.session();
      assert.ok(session !== undefined);
      const posts = states(window.record).length;

      // A second client (the owner's computer) blocks the ready plan; nothing on the lead's computer has seen it yet.
      const owner = await openLog(rig, 'owner');
      await owner.log.append(() => [{ type: 'item.blocked', body: { id: READY_PLAN, reason: 'waiting for a teammate' } }]);
      assert.equal(session.state().items.get(READY_PLAN)?.blocked, undefined, 'the lead has not synced');
      assert.equal(states(window.record).length, posts, 'and the section has not changed');

      spy = timerOrigins();
      session.nudge();
      const record = window.record;
      await until(() => lastState(record)?.board?.blocked === before.blocked + 1, 'the section to show the block');
      spy.restore();
      const after = lastState(record)?.board;
      assert.deepEqual(after, {
        ready: before.ready - 1, blocked: before.blocked + 1, mine: before.mine, text: text.boardSummaryText(before.ready - 1, before.blocked + 1, before.mine)
      });
      assert.deepEqual(handleSummary(window.handle), { ready: before.ready - 1, blocked: before.blocked + 1, mine: before.mine });
      const own = spy.stacks.filter((stack) => OWN_CODE.some((file) => stack.includes(file)));
      assert.deepEqual(own, [], 'neither the Team section nor the summary started a timer');
    } finally {
      spy?.restore();
      await closeLeadWindow(window);
    }
  });
});

test('the Team section host has no timer of its own: its refreshes come from the session, Team Mode, its own actions and visibility', () => {
  for (const file of OWN_CODE) {
    const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /\bset(Timeout|Interval)\s*\(/, file);
  }
});

test('a removed member\'s handle gives no summary, and the section shows the removed state with no board line', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    let window: LeadWindow | undefined;
    try {
      window = await openLeadWindow(rig);
      assert.ok(lastState(window.record)?.board !== undefined, 'the line is shown while the lead is on the team');
      await remove(rig, 'owner', rig.lead);
      const session = window.handle.session();
      assert.ok(session !== undefined);
      session.nudge();
      const record = window.record;
      await until(() => lastState(record)?.status === text.TEAM_STATUS.removed, 'the section to show the removal');
      assert.equal(handleSummary(window.handle), undefined, 'the handle gives nothing to a removed member');
      const model = lastState(record);
      assert.equal(model?.board, undefined, 'no board line');
      assert.deepEqual(model?.actions, [], 'and no button');
    } finally {
      await closeLeadWindow(window);
    }
  });
});
