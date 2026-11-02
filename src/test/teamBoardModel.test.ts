// The Team Board model (D-07, D-08, D-12, D-13, D-15, D-16, D-18): one pure function of the log decides what the board shows and which moves it offers.
// The tracer builds a model from real signed events, plans a hold with planMove, applies it through the materialiser and shows the card leave
// Ready for Backlog. Lanes, filters, ordering, card faces and card detail follow in the same file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel, buildCardDetail, planMove } from '../domain/team/board';
import type { BoardModel, BoardModelOptions, CardDetail } from '../domain/team/board';
import * as boardText from '../domain/team/boardText';
import { ageText, cardLabel, estimateSpoken, estimateText, flattenName, historySentence, notReadyRefusal, notReadySentences, notReadyText, staleRefusal } from '../domain/team/boardText';
import { ItemHistory } from '../domain/team/itemHistory';
import type { HistoryEntry } from '../domain/team/itemHistory';
import { BOARD_COLUMNS } from '../domain/team/work';
import { CHORE_ID, boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');

function optionsFor(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModelOptions {
  return { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }), ...extra };
}

function modelFor(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModel {
  return buildBoardModel(world.state, optionsFor(world, viewerId, extra));
}

function card(model: BoardModel, id: string): BoardModel['cards'][number] {
  const found = model.cards.find((entry) => entry.id === id);
  assert.ok(found, `card ${id} is on the board`);
  return found;
}

test('tracer: a model from real events, a hold planned with planMove and applied, and the card moving from Ready to Backlog', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  const before = modelFor(world, world.owner.memberId);

  assert.deepEqual(before.columns.map((column) => column.key), [...BOARD_COLUMNS]);
  assert.deepEqual(before.columns.map((column) => column.label), ['Backlog', 'Ready', 'Claimed', 'In progress', 'In review', 'Integrating', 'Done', 'Cancelled']);
  assert.deepEqual(before.columns.map((column) => column.caption), [
    'Waiting, on hold or not ready.', 'Ready to be claimed.', 'Claiming arrives in a later update.', 'Starting work arrives with claims.',
    'Review arrives in a later update.', 'Merging arrives in a later update.', undefined, undefined
  ]);
  assert.deepEqual(before.cards.map((entry) => [entry.id, entry.column]), [['plan:90-02', 'backlog'], [CHORE_ID, 'backlog'], ['plan:90-01', 'ready']]);
  assert.equal(before.selectedMilestone, 'milestone:v0.9.0');

  const ready = card(before, 'plan:90-01');
  assert.deepEqual(ready.moves.map((move) => move.key), ['done', 'cancel', 'hold', 'block']);
  assert.deepEqual(ready.refusals, {
    claimed: 'Claiming a plan arrives in a later update. Nothing was moved.',
    'in-progress': 'Starting work from the board arrives with claims in a later update. Nothing was moved.',
    'in-review': 'Review arrives in a later update. Nothing was moved.',
    integrating: 'Merging arrives in a later update. Nothing was moved.'
  });

  const plan = planMove(world.state, world.owner.memberId, 'plan:90-01', 'hold');
  assert.deepEqual(plan, { ok: true, intent: { type: 'item.updated', body: { id: 'plan:90-01', changes: { hold: true } } } });
  if (!plan.ok) return;
  world.accept(world.owner, plan.intent.type, plan.intent.body as never);

  const after = modelFor(world, world.owner.memberId);
  const held = card(after, 'plan:90-01');
  assert.equal(held.column, 'backlog');
  assert.equal(held.held, true);
  assert.deepEqual(held.moves.map((move) => move.key), ['done', 'cancel', 'release', 'block']);
  assert.equal(card(before, 'plan:90-01').held, false, 'the earlier model is a snapshot and does not change');

  const refused = planMove(world.state, world.dev.memberId, 'plan:90-01', 'release');
  assert.deepEqual(refused, { ok: false, reason: 'Only the team owner or a lead can move cards. Nothing was moved.' });
});

// ---- the fuller world: two milestones, tasks, dependencies, a blocked plan and a chore -------------------------------------------------------

const AGE_NOW = Date.parse('2026-03-04T10:30:00.000Z');
const LEAD_BLOCK_REASON = 'waiting for the API key';

async function fullWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner, lead, dev } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v0.8.0', kind: 'milestone', title: 'Version 0.8.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:80', kind: 'phase', title: 'Old work', parentId: 'milestone:v0.8.0' }));
  world.accept(owner, 'item.imported', importedBody({
    id: 'plan:80-01', kind: 'plan', title: 'Prior work', parentId: 'phase:80', state: 'done', scope: ['src/old/**'], estimate: { tokens: 20000 }, requirements: ['BOARD-03']
  }));
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0', active: true }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:90', kind: 'phase', title: 'Alpha work', parentId: 'milestone:v0.9.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:91', kind: 'phase', title: 'Beta work', parentId: 'milestone:v0.9.0' }));
  world.accept(owner, 'item.imported', importedBody({
    id: 'plan:90-01', kind: 'plan', title: 'Alpha slice', parentId: 'phase:90', scope: ['src/a/**', 'docs/alpha.md'], estimate: { tokens: 48000 }, dependsOn: ['plan:80-01'],
    requirements: ['BOARD-01'], mustHaves: ['The slice works end to end'], gsd: { phase: '90', plan: '01', wave: 1 }
  }));
  world.accept(owner, 'item.imported', importedBody({
    id: 'plan:90-02', kind: 'plan', title: 'Beta slice', parentId: 'phase:90', scope: ['src/b/**'], estimate: { tokens: 12000 }, dependsOn: ['plan:90-01', 'plan:61-09'], requirements: ['BOARD-02']
  }));
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:90-03', kind: 'plan', title: 'Gamma slice', parentId: 'phase:90' }));
  world.accept(owner, 'item.updated', { id: 'plan:90-03', changes: { summary: true } });
  world.accept(owner, 'item.imported', importedBody({ id: 'task:90-01-1', kind: 'task', title: 'Write the test', parentId: 'plan:90-01' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'task:90-01-2', kind: 'task', title: 'Write the code', parentId: 'plan:90-01' }));
  world.accept(dev, 'item.created', { id: CHORE_ID, kind: 'chore', title: 'Tidy settings page', scope: ['src/settings/**'], requirements: [], mustHaves: [], description: 'Clean up the settings page.' });
  world.accept(lead, 'item.blocked', { id: 'plan:90-02', reason: LEAD_BLOCK_REASON });
  return world;
}

const PROGRESS_NONE = { percent: 0, done: 0, total: 0, text: 'No plans yet' };

test('lanes: member gives one Unassigned lane, phase and milestone lanes carry weighted progress, and an empty phase starts collapsed', async () => {
  const world = await fullWorld();
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  const model = modelFor(world, world.owner.memberId, { nowMs: AGE_NOW });

  assert.deepEqual(model.lanes.member, [{ key: 'unassigned', label: 'Unassigned', count: 4, collapsedByDefault: false }]);
  assert.deepEqual(model.lanes.none, [{ key: 'all', label: 'All cards', count: 4, collapsedByDefault: false }]);
  assert.deepEqual(model.lanes.phase, [
    { key: 'phase:80', label: 'Phase 80: Old work', count: 0, collapsedByDefault: false, milestoneId: 'milestone:v0.8.0', progress: { percent: 100, done: 1, total: 1, text: '100%, 1 of 1 plans done' } },
    { key: 'phase:90', label: 'Phase 90: Alpha work', count: 3, collapsedByDefault: false, milestoneId: 'milestone:v0.9.0', progress: { percent: 80, done: 1, total: 3, text: '80%, 1 of 3 plans done' } },
    { key: 'phase:91', label: 'Phase 91: Beta work', count: 0, collapsedByDefault: true, milestoneId: 'milestone:v0.9.0', progress: PROGRESS_NONE },
    { key: 'board', label: 'Added on the board', count: 1, collapsedByDefault: false }
  ]);
  assert.deepEqual(model.lanes.milestone, [
    { key: 'milestone:v0.9.0', label: 'Version 0.9.0', count: 3, collapsedByDefault: false, milestoneId: 'milestone:v0.9.0', progress: { percent: 80, done: 1, total: 3, text: '80%, 1 of 3 plans done' } },
    { key: 'milestone:v0.8.0', label: 'Version 0.8.0', count: 0, collapsedByDefault: false, milestoneId: 'milestone:v0.8.0', progress: { percent: 100, done: 1, total: 1, text: '100%, 1 of 1 plans done' } },
    { key: 'board', label: 'Added on the board', count: 1, collapsedByDefault: false }
  ]);
  assert.deepEqual(card(model, 'plan:90-02').lane, { member: 'unassigned', phase: 'phase:90', milestone: 'milestone:v0.9.0' });
  assert.deepEqual(card(model, CHORE_ID).lane, { member: 'unassigned', phase: 'board', milestone: 'board' });
});

test('the board has no "Added on the board" lane until a board item exists', async () => {
  const world = await boardWorld();
  world.accept(world.owner, 'item.imported', importedBody({ id: 'milestone:v1.0.0', kind: 'milestone', title: 'One', active: true }));
  world.accept(world.owner, 'item.imported', importedBody({ id: 'phase:1', kind: 'phase', title: 'First', parentId: 'milestone:v1.0.0' }));
  const model = modelFor(world, world.owner.memberId);
  assert.deepEqual(model.lanes.phase.map((lane) => lane.key), ['phase:1']);
  assert.deepEqual(model.lanes.milestone.map((lane) => lane.key), ['milestone:v1.0.0']);
  assert.deepEqual(model.cards, []);
  assert.equal(model.selectedMilestone, 'milestone:v1.0.0');
  const bare = modelFor(await boardWorld(), undefined);
  assert.equal(bare.selectedMilestone, 'all');
  assert.deepEqual(bare.milestones, []);
});

test('milestones list each imported milestone with its progress, the active one first and selected by default', async () => {
  const world = await fullWorld();
  const model = modelFor(world, world.owner.memberId);
  assert.deepEqual(model.milestones, [
    { id: 'milestone:v0.9.0', title: 'Version 0.9.0', active: true, progress: { percent: 0, done: 0, total: 3, text: '0%, 0 of 3 plans done' } },
    { id: 'milestone:v0.8.0', title: 'Version 0.8.0', active: false, progress: { percent: 100, done: 1, total: 1, text: '100%, 1 of 1 plans done' } }
  ]);
  assert.equal(model.selectedMilestone, 'milestone:v0.9.0');
  assert.deepEqual(model.counts, { cards: 4, ready: 1, blocked: 1 });
  assert.deepEqual(model.columns.map((column) => [column.key, column.count]), [['backlog', 3], ['ready', 1], ['claimed', 0], ['in-progress', 0], ['in-review', 0], ['integrating', 0], ['done', 0], ['cancelled', 0]]);
  // Cards of every milestone are in the model so the milestone picker can switch without asking the host; board items belong to every selection.
  assert.equal(card(model, 'plan:80-01').milestoneId, 'milestone:v0.8.0');
  assert.equal(card(model, CHORE_ID).milestoneId, undefined);
});

test('filter facets: phases with their milestone, the sorted requirement ids on cards, and mine only for board items the viewer created', async () => {
  const world = await fullWorld();
  const model = modelFor(world, world.dev.memberId);
  assert.deepEqual(model.phases, [
    { id: 'phase:80', title: 'Phase 80: Old work', milestoneId: 'milestone:v0.8.0' },
    { id: 'phase:90', title: 'Phase 90: Alpha work', milestoneId: 'milestone:v0.9.0' },
    { id: 'phase:91', title: 'Phase 91: Beta work', milestoneId: 'milestone:v0.9.0' }
  ]);
  assert.deepEqual(model.requirements, ['BOARD-01', 'BOARD-02', 'BOARD-03']);
  assert.deepEqual(model.cards.filter((entry) => entry.mine).map((entry) => entry.id), [CHORE_ID]);
  assert.deepEqual(modelFor(world, world.owner.memberId).cards.filter((entry) => entry.mine), []);
  assert.deepEqual(modelFor(world, undefined).cards.filter((entry) => entry.mine), []);
  assert.deepEqual(card(model, 'plan:90-01').phaseId, 'phase:90');
  assert.equal(card(model, CHORE_ID).phaseId, undefined);
});

// ---- ordering --------------------------------------------------------------------------------------------------------------------------------

test('cards sort by phase then plan number in each column (numerically), board items after plans, and the reverse in Done and Cancelled', async () => {
  const world = await boardWorld();
  const { owner, dev } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v1.0.0', kind: 'milestone', title: 'One', active: true }));
  const numbers = ['10.1', '10', '9'];
  for (const number of numbers) world.accept(owner, 'item.imported', importedBody({ id: `phase:${number}`, kind: 'phase', title: `Phase ${number}`, parentId: 'milestone:v1.0.0' }));
  const plans: Array<[string, string]> = [['10.1', '01'], ['10', '02'], ['9', '01'], ['10', '01']];
  for (const [phase, plan] of plans) world.accept(owner, 'item.imported', importedBody({ id: `plan:${phase}-${plan}`, kind: 'plan', title: `Plan ${phase}-${plan}`, parentId: `phase:${phase}` }));
  const first = `item:${'0'.repeat(22)}AAAA`;
  const second = `item:${'0'.repeat(22)}BBBB`;
  world.accept(dev, 'item.created', { id: second, kind: 'bug', title: 'Second in the log', scope: [], requirements: [], mustHaves: [] });
  world.accept(dev, 'item.created', { id: first, kind: 'chore', title: 'Third in the log', scope: [], requirements: [], mustHaves: [] });

  const ids = (model: BoardModel, column: string): string[] => model.cards.filter((entry) => entry.column === column).map((entry) => entry.id);
  const backlog = ['plan:9-01', 'plan:10-01', 'plan:10-02', 'plan:10.1-01', second, first];
  const model = modelFor(world, owner.memberId);
  assert.deepEqual(ids(model, 'backlog'), backlog, 'ascending, numeric, board items after plans in log order');
  assert.deepEqual(modelFor(world, owner.memberId, { nowMs: AGE_NOW + 86_400_000 * 40 }).cards.map((entry) => entry.id), model.cards.map((entry) => entry.id), 'the order never depends on the clock');

  for (const id of backlog) world.accept(owner, 'item.updated', { id, changes: { state: 'done' } });
  assert.deepEqual(ids(modelFor(world, owner.memberId), 'done'), ['plan:10.1-01', 'plan:10-02', 'plan:10-01', 'plan:9-01', first, second], 'descending in Done, plans before board items');
});

// ---- card face -------------------------------------------------------------------------------------------------------------------------------

test('the card face: display ids, estimate and age text, flags, dependency count and the accessible name', async () => {
  const world = await fullWorld();
  const model = modelFor(world, world.owner.memberId, { nowMs: AGE_NOW });
  const alpha = card(model, 'plan:90-01');
  assert.equal(alpha.displayId, '90-01');
  assert.equal(alpha.title, 'Alpha slice');
  assert.equal(alpha.kind, 'plan');
  assert.equal(alpha.stateLabel, 'Ready');
  assert.equal(alpha.estimateText, '48k tokens');
  assert.equal(alpha.ageText, '3 days');
  assert.equal(alpha.dependencyCount, 1);
  assert.equal(alpha.held, false);
  assert.equal(alpha.doneInGsd, false);
  assert.equal(alpha.a11yLabel, 'Plan 90-01, Alpha slice. State: Ready. Blocked: no. 1 dependency. Estimated 48 thousand tokens. In this state for 3 days.');

  const beta = card(model, 'plan:90-02');
  assert.deepEqual(beta.blocked, { reason: LEAD_BLOCK_REASON, byName: 'Lee', since: beta.blocked?.since });
  assert.equal(beta.dependencyCount, 2);
  assert.equal(beta.a11yLabel, 'Plan 90-02, Beta slice. State: Backlog. Blocked: waiting for the API key. 2 dependencies. Estimated 12 thousand tokens. In this state for 3 days.');

  const gamma = card(model, 'plan:90-03');
  assert.equal(gamma.doneInGsd, true);
  assert.equal(gamma.estimateText, 'No estimate');
  assert.equal(gamma.a11yLabel, 'Plan 90-03, Gamma slice. State: Backlog. Blocked: no. Done in GSD, waiting for confirmation. No dependencies. No estimate. In this state for 3 days.');

  const chore = card(model, CHORE_ID);
  assert.equal(chore.displayId, 'Chore 7F3K');
  assert.equal(chore.createdByName, 'Dana');
  assert.equal(chore.a11yLabel, 'Chore 7F3K, Tidy settings page. State: Backlog. Blocked: no. No dependencies. No estimate. In this state for 3 days.');

  const done = card(model, 'plan:80-01');
  assert.equal(done.column, 'done');
  assert.ok(done.a11yLabel.startsWith('Plan 80-01, Prior work. State: Done.'));
  world.accept(world.owner, 'item.cancelled', { id: 'plan:90-03', reason: 'not needed' });
  assert.ok(card(modelFor(world, world.owner.memberId, { nowMs: AGE_NOW }), 'plan:90-03').a11yLabel.includes('State: Cancelled. Blocked: no. Cancelled.'));
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  assert.ok(card(modelFor(world, world.owner.memberId, { nowMs: AGE_NOW }), 'plan:90-01').a11yLabel.includes('Blocked: no. On hold. 1 dependency.'));
});

test('a held plan is shown on hold with the Backlog state word', async () => {
  const world = await fullWorld();
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  const held = card(modelFor(world, world.owner.memberId, { nowMs: AGE_NOW }), 'plan:90-01');
  assert.equal(held.stateLabel, 'Backlog');
  assert.equal(held.held, true);
});

test('a name or reason with a newline and 200 characters becomes one bounded line wherever it appears in the model', async () => {
  const world = await fullWorld();
  const hostile = `Lee\n${'x'.repeat(200)}`;
  const member = world.state.members.get(world.lead.memberId);
  assert.ok(member);
  member.name = hostile;
  const dana = world.state.members.get(world.dev.memberId);
  assert.ok(dana);
  dana.name = `\u0007Dana\t${'y'.repeat(100)}`;
  const model = modelFor(world, world.lead.memberId, { nowMs: AGE_NOW });
  const expectedLead = `${`Lee ${'x'.repeat(200)}`.slice(0, 60)}...`;
  assert.equal(card(model, 'plan:90-02').blocked?.byName, expectedLead);
  assert.equal(model.viewer.name, expectedLead);
  assert.equal(card(model, CHORE_ID).createdByName, `${`Dana ${'y'.repeat(100)}`.slice(0, 60)}...`);
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(model);
  for (const text of strings) assert.doesNotMatch(text, /[\u0000-\u001F\u007F\u2028\u2029]/, JSON.stringify(text));
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-01', reason: 'x'.repeat(190) });
  assert.equal(card(modelFor(world, world.lead.memberId, { nowMs: AGE_NOW }), 'plan:90-01').blocked?.reason, 'x'.repeat(190));
});

test('the model is plain JSON: it survives a round trip unchanged and holds no undefined values', async () => {
  const world = await fullWorld();
  for (const viewerId of [world.owner.memberId, world.dev.memberId, world.observer.memberId, undefined]) {
    const model = modelFor(world, viewerId, { nowMs: AGE_NOW });
    assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
  }
});

test('viewer facts: what each role may do and the banner that says why not', async () => {
  const world = await fullWorld();
  const viewerOf = (id: string | undefined, extra: Partial<BoardModelOptions> = {}) => modelFor(world, id, extra).viewer;
  assert.deepEqual(viewerOf(world.owner.memberId), { name: 'Owner Test', role: 'owner', canWrite: true, canImport: true, canCreate: true });
  assert.deepEqual(viewerOf(world.lead.memberId), { name: 'Lee', role: 'lead', canWrite: true, canImport: true, canCreate: true });
  assert.deepEqual(viewerOf(world.dev.memberId), {
    name: 'Dana', role: 'developer', canWrite: true, canImport: false, canCreate: true, readOnlyReason: 'You can add items and edit your own drafts. Leads and the owner move cards.'
  });
  for (const actor of [world.reviewer, world.observer]) {
    assert.deepEqual(viewerOf(actor.memberId), {
      name: world.state.members.get(actor.memberId)?.name, role: world.state.members.get(actor.memberId)?.role, canWrite: true, canImport: false, canCreate: false,
      readOnlyReason: 'You can look at the board but not change it. A lead can change your role.'
    });
  }
  assert.deepEqual(viewerOf(undefined), {
    name: '', canWrite: false, canImport: false, canCreate: false, readOnlyReason: 'This computer has no device key for this team, so it can read the team log but not write to it.'
  });
  assert.deepEqual(viewerOf(world.owner.memberId, { canWrite: false, readOnlyReason: 'You are offline.' }), {
    name: 'Owner Test', role: 'owner', canWrite: false, canImport: false, canCreate: false, readOnlyReason: 'You are offline.'
  });
});

// ---- card detail -----------------------------------------------------------------------------------------------------------------------------

function historyOf(world: BoardWorld): ItemHistory {
  const history = new ItemHistory();
  history.record(world.entries);
  return history;
}

function detailOf(world: BoardWorld, id: string, viewerId: string | undefined, history: ItemHistory = historyOf(world)): CardDetail | undefined {
  return buildCardDetail(world.state, id, { ...(viewerId === undefined ? {} : { viewerId }), nowMs: AGE_NOW, history: history.forItem(id) });
}

function mustDetail(world: BoardWorld, id: string, viewerId: string | undefined, history?: ItemHistory): CardDetail {
  const detail = detailOf(world, id, viewerId, history);
  assert.ok(detail, `detail for ${id}`);
  return detail;
}

test('card detail for a plan: must-haves, requirements, dependencies with their state, files, tasks, facts and the reasons it is not ready', async () => {
  const world = await fullWorld();
  const alpha = mustDetail(world, 'plan:90-01', world.owner.memberId);
  assert.equal(alpha.itemId, 'plan:90-01');
  assert.equal(alpha.displayId, '90-01');
  assert.equal(alpha.kind, 'plan');
  assert.equal(alpha.kindLabel, 'Plan');
  assert.equal(alpha.title, 'Alpha slice');
  assert.equal(alpha.column, 'ready');
  assert.equal(alpha.estimateTokens, 48000);
  assert.equal(alpha.description, undefined);
  assert.deepEqual(alpha.mustHaves, ['The slice works end to end']);
  assert.deepEqual(alpha.requirements, ['BOARD-01']);
  assert.deepEqual(alpha.files, ['src/a/**', 'docs/alpha.md']);
  assert.deepEqual(alpha.dependencies, [{ id: 'plan:80-01', label: '80-01 Prior work', stateLabel: 'Done', done: true, onBoard: true }]);
  assert.deepEqual(alpha.tasks, { done: 0, total: 2, summary: '0 of 2 tasks done', items: [{ id: 'task:90-01-1', title: 'Write the test', done: false }, { id: 'task:90-01-2', title: 'Write the code', done: false }] });
  assert.deepEqual(alpha.notReady, []);
  assert.equal(alpha.editable, false, 'imported items are never editable on the board');
  assert.deepEqual(alpha.facts, { phase: 'Phase 90: Alpha work', milestone: 'Version 0.9.0', wave: 1, estimate: '48k tokens', age: '3 days', source: 'From the project plans' });

  const beta = mustDetail(world, 'plan:90-02', world.owner.memberId);
  assert.deepEqual(beta.notReady, ['It is blocked.', 'It waits for 1 unfinished plan.', 'A plan it depends on is not on the board.']);
  assert.deepEqual(beta.dependencies, [
    { id: 'plan:90-01', label: '90-01 Alpha slice', stateLabel: 'Ready', done: false, onBoard: true },
    { id: 'plan:61-09', label: '61-09 (not on the board)', done: false, onBoard: false }
  ]);
  assert.equal(beta.blocked?.byName, 'Lee');
  assert.deepEqual(beta.tasks, { done: 0, total: 0, summary: '', items: [] });

  const gamma = mustDetail(world, 'plan:90-03', world.owner.memberId);
  assert.deepEqual(gamma.notReady, ['It has no estimate.', 'It lists no files.']);
  assert.equal(gamma.doneInGsd, true);
  assert.equal(gamma.facts.estimate, 'No estimate');
});

test('tasks count as done when their plan is done', async () => {
  const world = await fullWorld();
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  const alpha = mustDetail(world, 'plan:90-01', world.owner.memberId);
  assert.deepEqual(alpha.tasks, { done: 2, total: 2, summary: '2 of 2 tasks done', items: [{ id: 'task:90-01-1', title: 'Write the test', done: true }, { id: 'task:90-01-2', title: 'Write the code', done: true }] });
  assert.deepEqual(alpha.notReady, [], 'a done card has no reasons');
});

test('card detail for a board item: description, creator, and who may edit it', async () => {
  const world = await fullWorld();
  const forDev = mustDetail(world, CHORE_ID, world.dev.memberId);
  assert.equal(forDev.description, 'Clean up the settings page.');
  assert.equal(forDev.kindLabel, 'Chore');
  assert.equal(forDev.displayId, 'Chore 7F3K');
  assert.deepEqual(forDev.facts, { createdBy: 'Dana', estimate: 'No estimate', age: '3 days', source: 'Added on the board' });
  assert.deepEqual(forDev.files, ['src/settings/**']);
  assert.deepEqual(forDev.notReady, ['It has no estimate.']);
  const editable = (viewerId: string | undefined): boolean => mustDetail(world, CHORE_ID, viewerId).editable;
  assert.deepEqual([world.dev, world.owner, world.lead, world.reviewer, world.observer].map((actor) => editable(actor.memberId)), [true, true, true, false, false]);
  assert.equal(editable(undefined), false);
  world.accept(world.owner, 'item.updated', { id: CHORE_ID, changes: { state: 'done' } });
  assert.equal(editable(world.dev.memberId), false, 'a developer edits only an unfinished draft');
  assert.equal(editable(world.owner.memberId), true);
});

test('there is no detail for a phase, a milestone, a task or an unknown id', async () => {
  const world = await fullWorld();
  for (const id of ['phase:90', 'milestone:v0.9.0', 'task:90-01-1', 'plan:99-99']) assert.equal(detailOf(world, id, world.owner.memberId), undefined, id);
});

test('history is plain sentences, newest first: who did what, with the hold direction worked out', async () => {
  const world = await fullWorld();
  world.accept(world.lead, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  world.accept(world.lead, 'item.updated', { id: 'plan:90-01', changes: { hold: false } });
  world.accept(world.lead, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { title: 'Alpha slice, renamed' } });
  const detail = mustDetail(world, 'plan:90-01', world.owner.memberId);
  assert.deepEqual(detail.history.map((row) => row.text), [
    'Import updated the title.', 'Lee put this on hold.', 'Lee released the hold.', 'Lee put this on hold.', 'Import added this to the board.'
  ]);
  assert.ok(detail.history.every((row) => /^\d{4}-\d{2}-\d{2}T/.test(row.at)));
  assert.equal(detail.historyNote, undefined);

  const beta = mustDetail(world, 'plan:90-02', world.owner.memberId);
  assert.deepEqual(beta.history.map((row) => row.text), ['Lee blocked this: waiting for the API key.', 'Import added this to the board.']);
  const chore = mustDetail(world, CHORE_ID, world.owner.memberId);
  assert.deepEqual(chore.history.map((row) => row.text), ['Dana added this to the board.']);
});

test('the hold direction is worked out from the creation and from each ending (cancel, reopen, done), and from the current hold when the window is cut', async () => {
  const world = await fullWorld();
  const { lead } = world;
  world.accept(lead, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  world.accept(lead, 'item.cancelled', { id: 'plan:90-01', reason: 'on second thought' });
  world.accept(lead, 'item.reopened', { id: 'plan:90-01' });
  world.accept(lead, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  world.accept(lead, 'item.updated', { id: 'plan:90-01', changes: { hold: false } });
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  const detail = mustDetail(world, 'plan:90-01', world.owner.memberId);
  assert.deepEqual(detail.history.map((row) => row.text), [
    'Owner Test marked this done.', 'Lee released the hold.', 'Lee put this on hold.', 'Lee reopened this.', 'Lee cancelled this: on second thought.', 'Lee put this on hold.', 'Import added this to the board.'
  ]);

  // A window that starts mid-way (the log is not replayed from the first event) still places the newest hold from the card's own hold flag,
  // and says "changed" for an older one that no ending or creation pins down.
  const entry = (eventId: string, type: string, changed?: string[]): HistoryEntry => ({ eventId, type, author: lead.memberId, at: '2026-03-02T00:00:00.000Z', ...(changed === undefined ? {} : { changed }) });
  const cut = [entry('e4', 'item.updated', ['hold']), entry('e3', 'item.updated', ['hold']), entry('e2', 'item.cancelled'), entry('e1', 'item.updated', ['hold'])];
  const unheld = buildCardDetail(world.state, 'plan:90-02', { nowMs: AGE_NOW, history: cut });
  assert.deepEqual(unheld?.history.map((row) => row.text), ['Lee released the hold.', 'Lee put this on hold.', 'Lee cancelled this.', 'Lee changed the hold.']);
  assert.deepEqual(buildCardDetail(world.state, 'plan:90-02', { nowMs: AGE_NOW, history: [entry('e6', 'item.updated', ['hold'])] })?.history.map((row) => row.text), ['Lee released the hold.']);
  world.accept(lead, 'item.updated', { id: 'plan:90-03', changes: { hold: true } });
  const nowHeld = buildCardDetail(world.state, 'plan:90-03', { nowMs: AGE_NOW, history: [entry('e5', 'item.updated', ['hold'])] });
  assert.deepEqual(nowHeld?.history.map((row) => row.text), ['Lee put this on hold.']);

  const stranger = buildCardDetail(world.state, 'plan:90-01', {
    nowMs: AGE_NOW, history: [{ eventId: 'evt-x', type: 'item.unblocked', author: 'mbr-0123456789abcdef', at: '2026-03-02T00:00:00.000Z' }]
  });
  assert.deepEqual(stranger?.history, [{ at: '2026-03-02T00:00:00.000Z', text: 'Someone unblocked this.' }]);
  assert.deepEqual(buildCardDetail(world.state, 'plan:90-01', { nowMs: AGE_NOW, history: [] })?.history, []);
});

test('history stops at the latest 50 changes and says so', async () => {
  const world = await fullWorld();
  for (let index = 0; index < 30; index += 1) {
    world.accept(world.lead, 'item.blocked', { id: 'plan:90-01', reason: `reason ${index}` });
    world.accept(world.lead, 'item.unblocked', { id: 'plan:90-01' });
  }
  const detail = mustDetail(world, 'plan:90-01', world.owner.memberId);
  assert.equal(detail.history.length, 50);
  assert.equal(detail.history[0]?.text, 'Lee unblocked this.');
  assert.equal(detail.history[1]?.text, 'Lee blocked this: reason 29.');
  assert.equal(detail.historyNote, 'Showing the latest 50 changes.');
  // A longer list handed in directly is cut to 50 as well.
  const many = Array.from({ length: 80 }, (_, index) => ({ eventId: `evt-${index}`, type: 'item.unblocked', author: world.lead.memberId, at: '2026-03-02T00:00:00.000Z' }));
  assert.equal(buildCardDetail(world.state, 'plan:90-01', { nowMs: AGE_NOW, history: many })?.history.length, 50);
});

// ---- text ------------------------------------------------------------------------------------------------------------------------------------

test('estimate text, spoken size and age text follow the card-face formats', () => {
  assert.deepEqual([800, 1, 1000, 1500, 48000, 999_999, 1_000_000, 1_200_000].map((tokens) => estimateText(tokens)), [
    '800 tokens', '1 token', '1k tokens', '1.5k tokens', '48k tokens', '1M tokens', '1M tokens', '1.2M tokens'
  ]);
  assert.equal(estimateText(undefined), 'No estimate');
  assert.deepEqual([800, 48000, 1_200_000].map((tokens) => estimateSpoken(tokens)), ['800 tokens', '48 thousand tokens', '1.2 million tokens']);
  const since = '2026-03-01T00:00:00.000Z';
  const at = (offsetMs: number): string => ageText(Date.parse(since) + offsetMs, since);
  const hour = 3_600_000;
  const day = 24 * hour;
  assert.deepEqual([0, 59 * 60_000, hour, 5 * hour, 23 * hour, day, 3 * day, 59 * day, 60 * day, 75 * day, 400 * day].map(at), [
    'Under 1 hour', 'Under 1 hour', '1 hour', '5 hours', '23 hours', '1 day', '3 days', '59 days', '2 months', '2 months', '13 months'
  ]);
  assert.equal(ageText(Date.parse(since) - day, since), 'Under 1 hour', 'a clock behind the event never shows a negative age');
  assert.equal(ageText(Date.now(), 'not a date'), 'Under 1 hour');
});

test('flattenName makes one bounded line: control characters become spaces, whitespace collapses, long text ends in three dots', () => {
  assert.equal(flattenName('  Dana\n\tSmith  '), 'Dana Smith');
  assert.equal(flattenName('a\u2028b\u0000c'), 'a b c');
  assert.equal(flattenName('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(flattenName('x'.repeat(61)), `${'x'.repeat(60)}...`);
  assert.equal(flattenName('x'.repeat(500), 200), `${'x'.repeat(200)}...`);
  assert.equal(flattenName('\u{1F600}'.repeat(70)), `${'\u{1F600}'.repeat(60)}...`, 'a cut never splits a surrogate pair');
});

test('the not-ready wording joins the reasons in a fixed order and counts what it waits for', () => {
  assert.equal(notReadyText(['no-scope', 'no-estimate'], 0), 'it has no estimate, it lists no files');
  assert.equal(notReadyText(['dependency-open'], 1), 'it waits for 1 unfinished plan');
  assert.equal(notReadyText(['dependency-open'], 3), 'it waits for 3 unfinished plans');
  assert.deepEqual(notReadySentences(['phase-held', 'held', 'blocked', 'dependency-missing', 'dependency-open', 'phase-dependency-open'], 2), [
    'It is blocked.', 'It is on hold.', 'Its phase is on hold.', 'It waits for 2 unfinished plans.', 'A plan it depends on is not on the board.', 'Its phase waits for an earlier phase.'
  ]);
});

test('no authored string and no string in a model or detail contains an em-dash or an en-dash', async () => {
  const dashes = /[\u2013\u2014]/;
  const seen: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') seen.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(Object.values(boardText).filter((value) => typeof value !== 'function'));
  const sample = [
    staleRefusal('Dana'), notReadyRefusal(['no-estimate', 'dependency-open'], 2, true), notReadyRefusal(['held'], 0, false), estimateText(1_500_000), estimateSpoken(2500),
    ageText(10 ** 13, '2020-01-01T00:00:00.000Z'), cardLabel({ isPlan: true, displayId: '1-01', title: 'T', stateLabel: 'Done', held: true, doneInGsd: true, cancelled: true, dependencyCount: 2, age: '3 days' }),
    ...['item.imported', 'item.created', 'item.updated', 'item.estimated', 'item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened', 'item.other'].flatMap((type) => [
      historySentence({ eventId: 'e', type, author: 'a', at: 'x', reason: 'why', changed: ['estimate', 'title'] }, 'Dana', { origin: 'import' }),
      historySentence({ eventId: 'e', type, author: 'a', at: 'x', changed: ['hold'] }, 'Dana', { origin: 'board', hold: 'on' }),
      historySentence({ eventId: 'e', type, author: 'a', at: 'x', changed: ['hold'] }, '', { origin: 'board', hold: 'off' }),
      historySentence({ eventId: 'e', type, author: 'a', at: 'x', changed: ['state'] }, 'Dana', { origin: 'board' })
    ])
  ];
  collect(sample);
  const world = await fullWorld();
  world.accept(world.owner, 'item.cancelled', { id: 'plan:90-03', reason: 'not needed' });
  for (const viewerId of [world.owner.memberId, world.dev.memberId, world.observer.memberId, undefined]) {
    collect(modelFor(world, viewerId, { nowMs: AGE_NOW }));
    for (const id of ['plan:90-01', 'plan:90-02', 'plan:90-03', CHORE_ID, 'plan:80-01']) collect(detailOf(world, id, viewerId));
  }
  assert.ok(seen.length > 300, `a thorough sweep (${seen.length} strings)`);
  for (const text of seen) assert.doesNotMatch(text, dashes, text);
});
