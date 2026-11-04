// Planless phases as Backlog cards, and what the board opens folded (G-62-3, plan 62-19). The owner saw "unassigned has a (40) but expanding it
// shows them in done and they aren't immediately visible": only plans were cards, lanes and columns started collapsed in the wrong places and
// finished work dominated. Owner decision 2026-11-03 (amends D-08, refines D-13): a phase with no plans at all shows as a card in Backlog, so
// upcoming work is visible as soon as the roadmap is imported; Backlog and Ready start open, the four later columns and Done and Cancelled start
// folded, and a lane starts collapsed only when it holds nothing outside Done and Cancelled. A phase card is a display rule of the board model
// only: isCard, readiness and the state machine are unchanged, so no event's acceptance and no hash moves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel, buildCardDetail, columnMove, planAssign } from '../domain/team/board';
import type { BoardModel, BoardModelOptions } from '../domain/team/board';
import { ItemHistory } from '../domain/team/itemHistory';
import { BOARD_COLUMNS, countReady, isCard } from '../domain/team/work';
import { CHORE_ID, boardWorld, importedBody } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const PHASE_REFUSAL = 'Plan this phase first. Its plans move on the board, not the phase. Nothing was moved.';
const NO_PLANS_DETAIL = 'This phase has no plans yet. Its plan cards show up here once its plans are written.';
const UPCOMING = ['63', '64', '65', '66', '67'];

function modelFor(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModel {
  return buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }), ...extra });
}

function card(model: BoardModel, id: string): BoardModel['cards'][number] {
  const found = model.cards.find((entry) => entry.id === id);
  assert.ok(found, `card ${id} is on the board`);
  return found;
}

// Like this repository's own roadmap at HEAD (teamImport.test.ts imports it): milestone v0.6.0 with Phases 60 to 62 fully done and Phases 63 to
// 67 imported with no plans, plus an older milestone and one chore added on the board.
async function repositoryWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner, dev } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v0.5.0', kind: 'milestone', title: 'Version 0.5.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:50', kind: 'phase', title: 'Earlier work', parentId: 'milestone:v0.5.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v0.6.0', kind: 'milestone', title: 'Team Mode', active: true }));
  for (const phase of ['60', '61', '62']) {
    world.accept(owner, 'item.imported', importedBody({ id: `phase:${phase}`, kind: 'phase', title: `Built phase ${phase}`, parentId: 'milestone:v0.6.0' }));
    for (const plan of ['01', '02']) {
      world.accept(owner, 'item.imported', importedBody({ id: `plan:${phase}-${plan}`, kind: 'plan', title: `Plan ${phase}-${plan}`, parentId: `phase:${phase}`, state: 'done', scope: ['src/**'], estimate: { tokens: 1000 } }));
    }
  }
  for (const phase of UPCOMING) {
    world.accept(owner, 'item.imported', importedBody({
      id: `phase:${phase}`, kind: 'phase', title: `Upcoming ${phase}`, parentId: 'milestone:v0.6.0', requirements: [`REQ-${phase}`], dependsOn: [`phase:${Number(phase) - 1}`]
    }));
  }
  world.accept(dev, 'item.created', { id: CHORE_ID, kind: 'chore', title: 'Tidy settings page', scope: [], requirements: [], mustHaves: [] });
  return world;
}

test('every phase with no plans is a Backlog card titled with its number, with no moves and one refusal for every other column', async () => {
  const world = await repositoryWorld();
  const model = modelFor(world, world.owner.memberId);
  const backlog = model.cards.filter((entry) => entry.column === 'backlog').map((entry) => entry.id);
  assert.deepEqual(backlog, [...UPCOMING.map((phase) => `phase:${phase}`), CHORE_ID], 'the five upcoming phases in number order, then the board item');

  const next = card(model, 'phase:63');
  assert.equal(next.kind, 'phase');
  assert.equal(next.displayId, 'Phase 63');
  assert.equal(next.title, 'Phase 63: Upcoming 63');
  assert.equal(next.column, 'backlog');
  assert.equal(next.stateLabel, 'Backlog');
  assert.deepEqual(next.lane, { member: 'unassigned', phase: 'phase:63', milestone: 'milestone:v0.6.0' });
  assert.equal(next.phaseId, 'phase:63');
  assert.equal(next.milestoneId, 'milestone:v0.6.0');
  assert.deepEqual(next.requirements, ['REQ-63']);
  assert.equal(next.dependencyCount, 1);
  assert.equal(next.estimateText, 'No plans yet');
  assert.equal(next.held, false);
  assert.equal(next.doneInGsd, false);
  assert.equal(next.mine, false);
  assert.deepEqual(next.moves, []);
  assert.deepEqual(next.refusals, Object.fromEntries(BOARD_COLUMNS.filter((column) => column !== 'backlog').map((column) => [column, PHASE_REFUSAL])));
  assert.equal(next.a11yLabel, 'Phase 63: Upcoming 63. State: Backlog. This phase has no plans yet. 1 dependency. In this state for 4 days.');
  assert.deepEqual(next.assignActions, ['assign'], 'a phase can be assigned (62-15)');
  assert.deepEqual(card(modelFor(world, world.dev.memberId), 'phase:63').assignActions, ['assign-me']);

  // A drop anywhere else says the same, whoever drops it; the phase itself is still not a card of the log.
  for (const column of BOARD_COLUMNS) {
    assert.deepEqual(columnMove(world.state, world.owner.memberId, 'phase:63', column), column === 'backlog' ? { ok: true } : { ok: false, reason: PHASE_REFUSAL }, column);
  }
  assert.deepEqual(columnMove(world.state, world.dev.memberId, 'phase:63', 'done'), { ok: false, reason: PHASE_REFUSAL });
  const phase = world.state.items.get('phase:63');
  assert.ok(phase);
  assert.equal(isCard(phase), false);
});

test('the repository-like board: five phase cards in Backlog of the current milestone, counted as cards but never as ready', async () => {
  const world = await repositoryWorld();
  const model = modelFor(world, world.owner.memberId);
  const phaseCards = model.cards.filter((entry) => entry.kind === 'phase');
  assert.deepEqual(phaseCards.map((entry) => entry.id), UPCOMING.map((phase) => `phase:${phase}`));
  assert.ok(phaseCards.every((entry) => entry.column === 'backlog' && entry.milestoneId === 'milestone:v0.6.0'));
  // phase:50 of the older milestone has no plans either, so it is a card there too, out of the current milestone's view.
  assert.equal(card(model, 'phase:50').milestoneId, 'milestone:v0.5.0');
  assert.deepEqual(model.counts, { cards: 6 + 5 + 1, ready: 0, blocked: 0 }, 'six done plans, five phase cards and the chore');
  assert.equal(countReady(world.state.items), 0);
  assert.deepEqual(model.columns.map((column) => [column.key, column.count]), [['backlog', 6], ['ready', 0], ['claimed', 0], ['in-progress', 0], ['in-review', 0], ['integrating', 0], ['done', 6], ['cancelled', 0]]);
});

test('a phase with plans is never a card, even when every plan was cancelled; a planless phase stored done sits in Done', async () => {
  const world = await repositoryWorld();
  const { owner } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:68', kind: 'phase', title: 'Dropped', parentId: 'milestone:v0.6.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:68-01', kind: 'plan', title: 'Dropped plan', parentId: 'phase:68' }));
  world.accept(owner, 'item.cancelled', { id: 'plan:68-01', reason: 'not needed' });
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:69', kind: 'phase', title: 'Finished without plans', parentId: 'milestone:v0.6.0', state: 'done' }));
  const model = modelFor(world, owner.memberId);
  for (const id of ['phase:60', 'phase:61', 'phase:62', 'phase:68']) assert.equal(model.cards.some((entry) => entry.id === id), false, id);
  assert.equal(card(model, 'phase:69').column, 'done');
  assert.equal(card(model, 'phase:69').stateLabel, 'Done');

  // Writing the first plan of an upcoming phase turns its card into a lane with that plan in it.
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:63-01', kind: 'plan', title: 'First plan', parentId: 'phase:63' }));
  const after = modelFor(world, owner.memberId);
  assert.equal(after.cards.some((entry) => entry.id === 'phase:63'), false);
  assert.equal(card(after, 'plan:63-01').lane.phase, 'phase:63');
});

test('inside Backlog, plans and phase cards go together by phase number then plan number, and board items follow', async () => {
  const world = await boardWorld();
  const { owner, dev } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v1.0.0', kind: 'milestone', title: 'One', active: true }));
  for (const phase of ['63', '64', '9', '65']) world.accept(owner, 'item.imported', importedBody({ id: `phase:${phase}`, kind: 'phase', title: `Phase ${phase}`, parentId: 'milestone:v1.0.0' }));
  world.accept(dev, 'item.created', { id: CHORE_ID, kind: 'chore', title: 'Chore', scope: [], requirements: [], mustHaves: [] });
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:64-02', kind: 'plan', title: 'Second', parentId: 'phase:64' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:64-01', kind: 'plan', title: 'First', parentId: 'phase:64' }));
  const backlog = modelFor(world, owner.memberId).cards.filter((entry) => entry.column === 'backlog').map((entry) => entry.id);
  assert.deepEqual(backlog, ['phase:9', 'phase:63', 'plan:64-01', 'plan:64-02', 'phase:65', CHORE_ID]);
});

test('the detail of a phase card: its milestone, dependencies, requirements and history, why it is not ready, no tasks and no editing', async () => {
  const world = await repositoryWorld();
  const { lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'phase:64', memberId: dev.memberId });
  const history = new ItemHistory();
  history.record(world.entries);
  const detail = buildCardDetail(world.state, 'phase:64', { viewerId: lead.memberId, nowMs: NOW, history: history.forItem('phase:64') });
  assert.ok(detail);
  assert.equal(detail.kind, 'phase');
  assert.equal(detail.kindLabel, 'Phase');
  assert.equal(detail.displayId, 'Phase 64');
  assert.equal(detail.title, 'Phase 64: Upcoming 64');
  assert.equal(detail.column, 'backlog');
  assert.equal(detail.facts.milestone, 'Team Mode');
  assert.equal(detail.facts.phase, undefined);
  assert.equal(detail.facts.estimate, 'No plans yet');
  assert.equal(detail.facts.source, 'From the project plans');
  assert.deepEqual(detail.requirements, ['REQ-64']);
  assert.deepEqual(detail.dependencies, [{ id: 'phase:63', label: 'Phase 63 Upcoming 63', stateLabel: 'Not done', done: false, onBoard: true }]);
  assert.deepEqual(detail.notReady, [NO_PLANS_DETAIL]);
  assert.deepEqual(detail.tasks, { done: 0, total: 0, summary: '', items: [] });
  assert.equal(detail.editable, false);
  assert.deepEqual(detail.assignee, { id: dev.memberId, name: 'Dana' });
  assert.deepEqual(detail.history.map((row) => row.text), ['Lee assigned this to Dana.', 'Import added this to the board.']);
  // A phase that has plans keeps no detail of its own: its plans are the cards.
  assert.equal(buildCardDetail(world.state, 'phase:61', { viewerId: lead.memberId, nowMs: NOW, history: [] }), undefined);
  // And an assigned phase card is the assignee's own, in her lane.
  const forDana = card(modelFor(world, dev.memberId), 'phase:64');
  assert.equal(forDana.mine, true);
  assert.equal(forDana.lane.member, dev.memberId);
  assert.deepEqual(planAssign(world.state, dev.memberId, 'phase:64', undefined), { ok: true, intent: { type: 'item.unassigned', body: { id: 'phase:64' } } });
});

test('Backlog and Ready start open; the four later columns, Done and Cancelled start folded', async () => {
  const model = modelFor(await repositoryWorld(), undefined);
  assert.deepEqual(model.columns.map((column) => [column.key, column.foldedByDefault]), [
    ['backlog', false], ['ready', false], ['claimed', true], ['in-progress', true], ['in-review', true], ['integrating', true], ['done', true], ['cancelled', true]
  ]);
});

test('a lane starts collapsed only when it holds nothing outside Done and Cancelled', async () => {
  const world = await repositoryWorld();
  const { lead, dev, owner } = world;
  const collapsed = (lanes: BoardModel['lanes'][keyof BoardModel['lanes']]): Array<[string, boolean]> => lanes.map((lane) => [lane.key, lane.collapsedByDefault]);
  const model = modelFor(world, owner.memberId);
  assert.deepEqual(collapsed(model.lanes.phase), [
    ['phase:50', true], ['phase:60', true], ['phase:61', true], ['phase:62', true], ...UPCOMING.map((phase): [string, boolean] => [`phase:${phase}`, false]), ['board', false]
  ], 'finished phases fold, upcoming phases with their phase cards stay open');
  assert.deepEqual(collapsed(model.lanes.milestone), [['milestone:v0.6.0', false], ['milestone:v0.5.0', true], ['board', false]]);
  assert.deepEqual(collapsed(model.lanes.member), [['unassigned', false]], 'Unassigned holds open cards');
  assert.deepEqual(collapsed(model.lanes.none), [['all', false]], 'the one lane of an ungrouped board never folds');

  // Dana's only card is finished, so her lane starts collapsed; Lee's holds an open phase card, so it starts open.
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  world.accept(owner, 'item.updated', { id: CHORE_ID, changes: { state: 'done' } });
  world.accept(lead, 'item.assigned', { id: 'phase:65', memberId: lead.memberId });
  assert.deepEqual(collapsed(modelFor(world, owner.memberId).lanes.member), [[dev.memberId, true], [lead.memberId, false], ['unassigned', false]]);
  // Once every open card has a person, Unassigned holds only finished work and folds too.
  for (const phase of ['63', '64', '66', '67']) world.accept(lead, 'item.assigned', { id: `phase:${phase}`, memberId: lead.memberId });
  assert.deepEqual(collapsed(modelFor(world, owner.memberId).lanes.member).at(-1), ['unassigned', true]);
});
